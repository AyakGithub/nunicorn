/**
 * 뉴니콘 관리자 위험 상담 검토함 API
 * GET   /api/admin/risk           검토 대기 목록 (위험도 우선순위)
 * POST  /api/admin/risk/flag      상담 위험 플래그 수동 업데이트
 * PATCH /api/admin/risk/resolve   검토 완료 처리 (검토 결과 기록)
 */
export const config = { runtime: 'edge' };

import { verifyAdmin, ok, err, handleOptions, parsePagination, logAudit } from './auth.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();

  const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
  if (errorResponse) return errorResponse;

  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === 'GET')                       return getRiskQueue(supaAdmin, url);
  if (req.method === 'POST' && path.endsWith('/flag'))    return flagChat(supaAdmin, adminUser, req);
  if (req.method === 'PATCH' && path.endsWith('/resolve')) return resolveRisk(supaAdmin, adminUser, req);

  return err(405, '허용되지 않는 메서드');
}

async function getRiskQueue(supaAdmin, url) {
  const { limit, offset } = parsePagination(url.toString());
  const p = url.searchParams;

  let query = supaAdmin
    .from('chat_logs')
    .select(
      'id,question,answer,risk_level,risk_flags,review_status,reviewer_note,' +
      'child_age_label,child_months,disclaimer_shown,created_at,user_id',
      { count: 'exact' }
    )
    .order('risk_level', { ascending: true })  // high가 먼저 (h < n, caution between)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // 기본: pending만 (필터 없을 때)
  const reviewStatus = p.get('review_status') || 'pending';
  if (reviewStatus !== 'all') query = query.eq('review_status', reviewStatus);

  // 위험도 필터
  if (p.get('risk_level')) query = query.eq('risk_level', p.get('risk_level'));
  else query = query.neq('risk_level', 'normal'); // normal 제외

  const { data, count, error } = await query;
  if (error) return err(500, '조회 오류: ' + error.message);

  return ok({
    items: (data ?? []).map(item => ({
      ...item,
      user_id: item.user_id ? item.user_id.slice(0, 8) + '...' : null,
      question: item.question,   // 위험 검토는 전문 노출
      answer: item.answer?.slice(0, 200) + (item.answer?.length > 200 ? '…' : ''),
    })),
    total: count ?? 0,
    limit,
    offset,
  });
}

async function flagChat(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { chat_id, risk_level, risk_flags, note } = body;
  if (!chat_id) return err(400, 'chat_id가 필요합니다');

  const VALID_RISK = ['normal', 'caution', 'high'];
  if (risk_level && !VALID_RISK.includes(risk_level)) {
    return err(400, '유효하지 않은 risk_level');
  }

  const { data: before } = await supaAdmin
    .from('chat_logs')
    .select('risk_level, risk_flags, review_status')
    .eq('id', chat_id)
    .maybeSingle();
  if (!before) return err(404, '상담 기록을 찾을 수 없습니다');

  const updateData = { reviewer_id: adminUser.id };
  if (risk_level) updateData.risk_level = risk_level;
  if (risk_flags) updateData.risk_flags = Array.isArray(risk_flags) ? risk_flags : [risk_flags];
  if (typeof note === 'string') updateData.reviewer_note = note;
  // 플래그 변경 시 pending으로 리셋 (재검토 필요)
  updateData.review_status = risk_level === 'normal' ? 'completed' : 'reviewing';

  const { error } = await supaAdmin.from('chat_logs').update(updateData).eq('id', chat_id);
  if (error) return err(500, '플래그 업데이트 오류: ' + error.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'risk_flag',
    targetType: 'chat_log',
    targetId: chat_id,
    beforeValue: { risk_level: before.risk_level, risk_flags: before.risk_flags },
    afterValue: updateData,
  });

  return ok({ success: true });
}

async function resolveRisk(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { chat_id, resolution, reviewer_note, final_risk_level } = body;
  if (!chat_id || !resolution) return err(400, 'chat_id와 resolution이 필요합니다');

  const VALID_RESOLUTIONS = ['normal', 'needs_revision', 'dangerous', 'false_positive'];
  if (!VALID_RESOLUTIONS.includes(resolution)) {
    return err(400, `resolution은 [${VALID_RESOLUTIONS.join(', ')}] 중 하나여야 합니다`);
  }

  const updateData = {
    review_status: 'completed',
    reviewer_id: adminUser.id,
    reviewer_note: reviewer_note || '',
  };
  if (final_risk_level) updateData.risk_level = final_risk_level;

  const { error } = await supaAdmin.from('chat_logs').update(updateData).eq('id', chat_id);
  if (error) return err(500, '검토 완료 오류: ' + error.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'risk_resolve',
    targetType: 'chat_log',
    targetId: chat_id,
    afterValue: { resolution, final_risk_level, reviewer_note },
  });

  return ok({ success: true });
}
