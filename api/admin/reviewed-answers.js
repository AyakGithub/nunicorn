/**
 * 뉴니콘 관리자 검수 답변 관리 API
 * GET    /api/admin/reviewed-answers               목록
 * GET    /api/admin/reviewed-answers?id=uuid       상세 (버전 이력 포함)
 * POST   /api/admin/reviewed-answers               신규 생성
 * PUT    /api/admin/reviewed-answers               수정 (기존 버전 보존)
 * DELETE /api/admin/reviewed-answers               비활성화
 */
export const config = { runtime: 'edge' };

import { verifyAdmin, ok, err, handleOptions, parsePagination, logAudit } from './auth.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();

  const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
  if (errorResponse) return errorResponse;

  const url = new URL(req.url);

  if (req.method === 'GET' && url.searchParams.get('id')) {
    return getDetail(supaAdmin, url.searchParams.get('id'));
  }
  if (req.method === 'GET')    return getList(supaAdmin, url);
  if (req.method === 'POST')   return createAnswer(supaAdmin, adminUser, req);
  if (req.method === 'PUT')    return updateAnswer(supaAdmin, adminUser, req);
  if (req.method === 'DELETE') return deactivateAnswer(supaAdmin, adminUser, req);

  return err(405, '허용되지 않는 메서드');
}

async function getList(supaAdmin, url) {
  const { limit, offset } = parsePagination(url.toString());
  const p = url.searchParams;

  let query = supaAdmin
    .from('reviewed_answers')
    .select(
      'id,topic,sub_topic,trigger_keywords,is_active,version,reviewed_by,reviewed_at,created_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (p.get('topic'))    query = query.eq('topic', p.get('topic'));
  if (p.get('keyword'))  query = query.ilike('trigger_keywords', `%${p.get('keyword')}%`);
  if (p.get('is_active') !== null && p.get('is_active') !== '') {
    query = query.eq('is_active', p.get('is_active') === 'true');
  }

  const { data, count, error } = await query;
  if (error) return err(500, '조회 오류');
  return ok({ items: data ?? [], total: count ?? 0, limit, offset });
}

async function getDetail(supaAdmin, id) {
  // 현재 버전
  const { data: answer, error } = await supaAdmin
    .from('reviewed_answers')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !answer) return err(404, '검수 답변을 찾을 수 없습니다');

  // 버전 이력
  const { data: versions } = await supaAdmin
    .from('reviewed_answer_versions')
    .select('version,answer_text,change_note,changed_by,created_at')
    .eq('reviewed_answer_id', id)
    .order('version', { ascending: false });

  return ok({ answer, versions: versions ?? [] });
}

async function createAnswer(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { topic, sub_topic, trigger_keywords, answer_text, source_chat_id, notes } = body;
  if (!topic || !trigger_keywords || !answer_text) {
    return err(400, '필수 필드 누락: topic, trigger_keywords, answer_text');
  }

  // trigger_keywords 형식 검증 (배열 또는 콤마 구분 문자열)
  const keywords = Array.isArray(trigger_keywords)
    ? trigger_keywords.join(',')
    : trigger_keywords;

  if (!keywords.trim()) return err(400, '트리거 키워드가 비어있습니다');

  const { data: newAnswer, error } = await supaAdmin
    .from('reviewed_answers')
    .insert({
      topic,
      sub_topic: sub_topic || null,
      trigger_keywords: keywords,
      answer_text,
      source_chat_id: source_chat_id || null,
      notes: notes || null,
      reviewed_by: adminUser.id,
      reviewed_at: new Date().toISOString(),
      version: 1,
      is_active: true,
    })
    .select()
    .single();

  if (error) return err(500, '생성 오류: ' + error.message);

  // 버전 이력 저장
  await supaAdmin.from('reviewed_answer_versions').insert({
    reviewed_answer_id: newAnswer.id,
    version: 1,
    answer_text,
    change_note: '초기 등록',
    changed_by: adminUser.id,
  });

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'reviewed_answer_create',
    targetType: 'reviewed_answer',
    targetId: newAnswer.id,
    afterValue: { topic, trigger_keywords: keywords, version: 1 },
  });

  return ok({ answer: newAnswer }, 201);
}

async function updateAnswer(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { id, topic, sub_topic, trigger_keywords, answer_text, notes, change_note } = body;
  if (!id) return err(400, 'id가 필요합니다');
  if (!change_note?.trim()) return err(400, '변경 사유(change_note)는 필수입니다');

  // 기존 버전 조회
  const { data: before } = await supaAdmin
    .from('reviewed_answers')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!before) return err(404, '검수 답변을 찾을 수 없습니다');

  const newVersion = (before.version || 1) + 1;
  const updateData = {
    version: newVersion,
    reviewed_by: adminUser.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (topic !== undefined)             updateData.topic = topic;
  if (sub_topic !== undefined)         updateData.sub_topic = sub_topic;
  if (trigger_keywords !== undefined) {
    updateData.trigger_keywords = Array.isArray(trigger_keywords)
      ? trigger_keywords.join(',')
      : trigger_keywords;
  }
  if (answer_text !== undefined)       updateData.answer_text = answer_text;
  if (notes !== undefined)             updateData.notes = notes;

  const { error } = await supaAdmin.from('reviewed_answers').update(updateData).eq('id', id);
  if (error) return err(500, '업데이트 오류: ' + error.message);

  // 이전 버전 스냅샷 보존
  await supaAdmin.from('reviewed_answer_versions').insert({
    reviewed_answer_id: id,
    version: newVersion,
    answer_text: answer_text ?? before.answer_text,
    change_note,
    changed_by: adminUser.id,
  });

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'reviewed_answer_update',
    targetType: 'reviewed_answer',
    targetId: id,
    beforeValue: { version: before.version, answer_text: before.answer_text?.slice(0, 100) },
    afterValue: { version: newVersion, change_note },
  });

  return ok({ success: true, new_version: newVersion });
}

async function deactivateAnswer(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }
  const { id, reason } = body;
  if (!id) return err(400, 'id가 필요합니다');

  const { error } = await supaAdmin
    .from('reviewed_answers')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return err(500, '비활성화 오류');

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'reviewed_answer_deactivate',
    targetType: 'reviewed_answer',
    targetId: id,
    afterValue: { reason },
  });

  return ok({ success: true });
}
