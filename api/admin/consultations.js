/**
 * 뉴니콘 관리자 상담 관리 API
 * GET  /api/admin/consultations          목록 (필터, 페이지네이션)
 * GET  /api/admin/consultations?id=uuid  상세
 * PATCH /api/admin/consultations         검토 상태·메모 업데이트
 */
export const config = { runtime: 'edge' };

import { verifyAdmin, ok, err, handleOptions, parsePagination, logAudit } from './auth.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();

  const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
  if (errorResponse) return errorResponse;

  const url = new URL(req.url);

  // ── 상세 조회 ──
  if (req.method === 'GET' && url.searchParams.get('id')) {
    return getDetail(supaAdmin, url.searchParams.get('id'));
  }

  // ── 목록 조회 ──
  if (req.method === 'GET') {
    return getList(supaAdmin, url);
  }

  // ── 검토 상태 업데이트 ──
  if (req.method === 'PATCH') {
    return updateReview(supaAdmin, adminUser, req);
  }

  return err(405, '허용되지 않는 메서드');
}

async function getList(supaAdmin, url) {
  const { limit, offset } = parsePagination(url.toString());
  const p = url.searchParams;

  let query = supaAdmin
    .from('chat_logs')
    .select(
      'id,question,status,risk_level,risk_flags,review_status,quota_deducted,' +
      'child_age_label,child_months,disclaimer_shown,created_at,user_id,error_code',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // 필터 적용
  if (p.get('status'))         query = query.eq('status', p.get('status'));
  if (p.get('risk_level'))     query = query.eq('risk_level', p.get('risk_level'));
  if (p.get('review_status'))  query = query.eq('review_status', p.get('review_status'));
  if (p.get('date_from'))      query = query.gte('created_at', p.get('date_from'));
  if (p.get('date_to'))        query = query.lte('created_at', p.get('date_to') + 'T23:59:59Z');
  if (p.get('user_id'))        query = query.eq('user_id', p.get('user_id'));
  if (p.get('keyword')) {
    query = query.ilike('question', `%${p.get('keyword')}%`);
  }
  if (p.get('quota_deducted') !== null && p.get('quota_deducted') !== undefined && p.get('quota_deducted') !== '') {
    query = query.eq('quota_deducted', p.get('quota_deducted') === 'true');
  }

  const { data, count, error } = await query;
  if (error) return err(500, '조회 오류: ' + error.message);

  return ok({
    items: (data ?? []).map(maskItem),
    total: count ?? 0,
    limit,
    offset,
  });
}

async function getDetail(supaAdmin, id) {
  const { data, error } = await supaAdmin
    .from('chat_logs')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) return err(500, '조회 오류');
  if (!data) return err(404, '상담 기록을 찾을 수 없습니다');

  // 상세 화면은 원문 제공 (관리자 권한 검증 완료)
  // 단, user_id는 부분 마스킹
  return ok({
    ...data,
    user_id: data.user_id ? data.user_id.slice(0, 8) + '...' : null,
  });
}

async function updateReview(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { id, review_status, reviewer_note } = body;
  if (!id) return err(400, 'id가 필요합니다');

  const VALID_STATUSES = ['pending','reviewing','normal','needs_revision','dangerous','completed'];
  if (review_status && !VALID_STATUSES.includes(review_status)) {
    return err(400, '유효하지 않은 검토 상태');
  }

  // 기존 값 조회 (감사 로그용)
  const { data: before } = await supaAdmin
    .from('chat_logs')
    .select('review_status, reviewer_note, reviewer_id')
    .eq('id', id)
    .maybeSingle();

  const updateData = {};
  if (review_status) updateData.review_status = review_status;
  if (typeof reviewer_note === 'string') updateData.reviewer_note = reviewer_note;
  updateData.reviewer_id = adminUser.id;

  const { error } = await supaAdmin
    .from('chat_logs')
    .update(updateData)
    .eq('id', id);

  if (error) return err(500, '업데이트 오류: ' + error.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'review_update',
    targetType: 'chat_log',
    targetId: id,
    beforeValue: before,
    afterValue: updateData,
  });

  return ok({ success: true });
}

function maskItem(row) {
  return {
    ...row,
    user_id: row.user_id ? row.user_id.slice(0, 8) + '...' : null,
    question: row.question?.slice(0, 80) + (row.question?.length > 80 ? '…' : ''),
  };
}
