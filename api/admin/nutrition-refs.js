/**
 * 뉴니콘 관리자 영양 기준값 API (KDRIs)
 * GET    /api/admin/nutrition-refs                    전체 목록
 * GET    /api/admin/nutrition-refs?nutrient=vitamin_d 특정 영양소 조회
 * PUT    /api/admin/nutrition-refs                    값 수정 (감사 로그 저장)
 * POST   /api/admin/nutrition-refs                    신규 항목 추가
 */
export const config = { runtime: 'edge' };

import { verifyAdmin, ok, err, handleOptions, logAudit } from './auth.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();

  const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
  if (errorResponse) return errorResponse;

  const url = new URL(req.url);

  if (req.method === 'GET') return getList(supaAdmin, url);
  if (req.method === 'POST') return createRef(supaAdmin, adminUser, req);
  if (req.method === 'PUT')  return updateRef(supaAdmin, adminUser, req);

  return err(405, '허용되지 않는 메서드');
}

async function getList(supaAdmin, url) {
  const p = url.searchParams;
  const nutrient = p.get('nutrient');

  let query = supaAdmin
    .from('nutrition_references')
    .select('*')
    .order('nutrient_key')
    .order('age_group_label');

  if (nutrient) query = query.eq('nutrient_key', nutrient);

  const { data, error } = await query;
  if (error) return err(500, '조회 오류: ' + error.message);

  // 영양소별로 그룹핑
  const grouped = {};
  for (const row of (data ?? [])) {
    if (!grouped[row.nutrient_key]) {
      grouped[row.nutrient_key] = { nutrient_key: row.nutrient_key, unit: row.unit, rows: [] };
    }
    grouped[row.nutrient_key].rows.push(row);
  }

  return ok({
    nutrients: Object.values(grouped),
    total: data?.length ?? 0,
    kdri_version: '2025',
  });
}

async function createRef(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { nutrient_key, age_group_label, age_min_months, age_max_months,
          recommended_intake, upper_limit, unit, kdri_year, notes } = body;

  if (!nutrient_key || !age_group_label || !unit) {
    return err(400, '필수 필드가 누락되었습니다 (nutrient_key, age_group_label, unit)');
  }

  // 값 범위 검증
  if (recommended_intake !== null && recommended_intake !== undefined && recommended_intake < 0) {
    return err(400, '권장량은 0 이상이어야 합니다');
  }
  if (upper_limit !== null && upper_limit !== undefined && upper_limit < 0) {
    return err(400, '상한량은 0 이상이어야 합니다');
  }
  if (upper_limit !== null && upper_limit !== undefined &&
      recommended_intake !== null && recommended_intake !== undefined &&
      upper_limit < recommended_intake) {
    return err(400, '상한량은 권장량보다 커야 합니다');
  }

  // 중복 확인
  const { data: existing } = await supaAdmin
    .from('nutrition_references')
    .select('id')
    .eq('nutrient_key', nutrient_key)
    .eq('age_group_label', age_group_label)
    .maybeSingle();
  if (existing) return err(409, '동일한 영양소·연령대가 이미 존재합니다. 수정 기능을 사용하세요.');

  const { data: newRef, error } = await supaAdmin
    .from('nutrition_references')
    .insert({ nutrient_key, age_group_label, age_min_months, age_max_months,
              recommended_intake, upper_limit, unit, kdri_year: kdri_year || 2025, notes })
    .select()
    .single();

  if (error) return err(500, '생성 오류: ' + error.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'nutrition_ref_create',
    targetType: 'nutrition_reference',
    targetId: newRef.id,
    afterValue: { nutrient_key, age_group_label, recommended_intake, upper_limit, unit },
  });

  return ok({ ref: newRef }, 201);
}

async function updateRef(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { id, recommended_intake, upper_limit, kdri_year, notes, change_note } = body;
  if (!id) return err(400, 'id가 필요합니다');

  // 기존 값 조회
  const { data: before } = await supaAdmin
    .from('nutrition_references')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!before) return err(404, '기준값을 찾을 수 없습니다');

  // 값 범위 검증
  const newRec = recommended_intake ?? before.recommended_intake;
  const newUL  = upper_limit ?? before.upper_limit;

  if (newRec !== null && newRec < 0) return err(400, '권장량은 0 이상이어야 합니다');
  if (newUL  !== null && newUL  < 0) return err(400, '상한량은 0 이상이어야 합니다');
  if (newUL !== null && newRec !== null && newUL < newRec) {
    return err(400, `상한량(${newUL})이 권장량(${newRec})보다 작습니다. 단위를 확인하세요.`);
  }

  const updateData = {};
  if (recommended_intake !== undefined) updateData.recommended_intake = recommended_intake;
  if (upper_limit !== undefined) updateData.upper_limit = upper_limit;
  if (kdri_year !== undefined) updateData.kdri_year = kdri_year;
  if (notes !== undefined) updateData.notes = notes;
  updateData.updated_at = new Date().toISOString();

  const { error } = await supaAdmin
    .from('nutrition_references')
    .update(updateData)
    .eq('id', id);

  if (error) return err(500, '업데이트 오류: ' + error.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'nutrition_ref_update',
    targetType: 'nutrition_reference',
    targetId: id,
    beforeValue: {
      recommended_intake: before.recommended_intake,
      upper_limit: before.upper_limit,
      kdri_year: before.kdri_year,
    },
    afterValue: { ...updateData, change_note },
  });

  return ok({ success: true, updated: { ...before, ...updateData } });
}
