/**
 * 뉴니콘 관리자 회원 관리 API
 * GET    /api/admin/users              회원 목록
 * GET    /api/admin/users?id=uuid      회원 상세 (아이 프로필 포함)
 * PATCH  /api/admin/users              쿼터 조정
 * DELETE /api/admin/users              계정 비활성화 (탈퇴 처리 아님)
 */
export const config = { runtime: 'edge' };

import { verifyAdmin, ok, err, handleOptions, parsePagination, logAudit } from './auth.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();

  const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
  if (errorResponse) return errorResponse;

  const url = new URL(req.url);

  if (req.method === 'GET' && url.searchParams.get('id')) {
    return getUserDetail(supaAdmin, url.searchParams.get('id'));
  }
  if (req.method === 'GET')    return getUserList(supaAdmin, url);
  if (req.method === 'PATCH')  return adjustQuota(supaAdmin, adminUser, req);
  if (req.method === 'DELETE') return deactivateUser(supaAdmin, adminUser, req);

  return err(405, '허용되지 않는 메서드');
}

async function getUserList(supaAdmin, url) {
  const { limit, offset } = parsePagination(url.toString());
  const p = url.searchParams;

  // auth.users를 직접 조회 (service role만 가능)
  const { data: authData, error: authError } = await supaAdmin.auth.admin.listUsers({
    page: parseInt(p.get('page') || '1'),
    perPage: limit,
  });

  if (authError) return err(500, '사용자 조회 오류: ' + authError.message);

  const users = authData?.users ?? [];
  const keyword = p.get('keyword') || '';

  // 이메일/ID 키워드 필터 (서버 필터링)
  const filtered = keyword
    ? users.filter(u =>
        u.email?.includes(keyword) ||
        u.id?.includes(keyword)
      )
    : users;

  // 각 유저의 아이 프로필 수 조회
  const userIds = filtered.map(u => u.id);
  let childCounts = {};
  if (userIds.length > 0) {
    const { data: children } = await supaAdmin
      .from('user_children')
      .select('user_id')
      .in('user_id', userIds);
    for (const c of (children ?? [])) {
      childCounts[c.user_id] = (childCounts[c.user_id] || 0) + 1;
    }
  }

  // 역할 조회
  const { data: roles } = await supaAdmin
    .from('user_roles')
    .select('user_id, role, is_active')
    .in('user_id', userIds);
  const roleMap = {};
  for (const r of (roles ?? [])) roleMap[r.user_id] = r;

  const items = filtered.map(u => ({
    id: u.id.slice(0, 8) + '...',   // 목록에서 마스킹
    full_id: u.id,                   // 상세 조회용
    email: maskEmail(u.email),
    provider: u.app_metadata?.provider || 'email',
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
    banned: u.banned_until != null,
    child_count: childCounts[u.id] || 0,
    role: roleMap[u.id]?.role || 'user',
    role_active: roleMap[u.id]?.is_active ?? true,
  }));

  return ok({ items, total: authData.total ?? items.length, limit, offset });
}

async function getUserDetail(supaAdmin, userId) {
  const { data: { user }, error } = await supaAdmin.auth.admin.getUserById(userId);
  if (error || !user) return err(404, '사용자를 찾을 수 없습니다');

  // 아이 프로필
  const { data: children } = await supaAdmin
    .from('user_children')
    .select('id, nickname, months, weight_kg, created_at')
    .eq('user_id', userId);

  // 최근 상담 5건
  const { data: recentChats } = await supaAdmin
    .from('chat_logs')
    .select('id, question, status, risk_level, quota_deducted, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);

  // 역할 정보
  const { data: roleData } = await supaAdmin
    .from('user_roles')
    .select('role, is_active, granted_at, granted_by')
    .eq('user_id', userId)
    .maybeSingle();

  // 쿼터 조정 이력
  const { data: quotaHistory } = await supaAdmin
    .from('quota_adjustments')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  return ok({
    id: user.id,
    email: user.email,               // 상세에서는 전체 이메일 (관리자만 접근)
    provider: user.app_metadata?.provider,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at,
    banned: user.banned_until != null,
    banned_until: user.banned_until,
    children: children ?? [],
    recentChats: (recentChats ?? []).map(c => ({
      ...c,
      question: c.question?.slice(0, 60) + (c.question?.length > 60 ? '…' : ''),
    })),
    role: roleData || null,
    quotaHistory: quotaHistory ?? [],
  });
}

async function adjustQuota(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { user_id, date, adjustment, reason } = body;
  if (!user_id || !date || adjustment === undefined) {
    return err(400, 'user_id, date, adjustment는 필수입니다');
  }

  // date 형식 검증 (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err(400, 'date 형식은 YYYY-MM-DD이어야 합니다');
  }

  const adj = parseInt(adjustment);
  if (isNaN(adj) || adj === 0) return err(400, 'adjustment는 0이 아닌 정수이어야 합니다');
  if (Math.abs(adj) > 50) return err(400, '1회 조정량은 ±50을 초과할 수 없습니다');

  // 사용자 존재 확인
  const { data: { user }, error: userError } = await supaAdmin.auth.admin.getUserById(user_id);
  if (userError || !user) return err(404, '사용자를 찾을 수 없습니다');

  // 조정 기록 저장
  const { data: adjustRecord, error: adjError } = await supaAdmin
    .from('quota_adjustments')
    .insert({
      user_id,
      date,
      adjustment: adj,
      reason: reason || '',
      adjusted_by: adminUser.id,
    })
    .select()
    .single();

  if (adjError) return err(500, '쿼터 조정 오류: ' + adjError.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'quota_adjust',
    targetType: 'user',
    targetId: user_id,
    afterValue: { date, adjustment: adj, reason },
  });

  return ok({ success: true, adjustment: adjustRecord });
}

async function deactivateUser(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }
  const { user_id, reason, duration_hours } = body;
  if (!user_id) return err(400, 'user_id가 필요합니다');

  // 자기 자신 비활성화 방지
  if (user_id === adminUser.id) return err(400, '자신의 계정을 비활성화할 수 없습니다');

  // ban_duration 설정 (기본 24시간)
  const hours = Math.min(duration_hours || 24, 8760); // 최대 365일
  const bannedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  const { error } = await supaAdmin.auth.admin.updateUserById(user_id, {
    ban_duration: `${hours}h`,
  });

  if (error) return err(500, '비활성화 오류: ' + error.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'user_deactivate',
    targetType: 'user',
    targetId: user_id,
    afterValue: { reason, banned_until: bannedUntil, duration_hours: hours },
  });

  return ok({ success: true, banned_until: bannedUntil });
}

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.slice(0, 2) + '***';
  return masked + '@' + domain;
}
