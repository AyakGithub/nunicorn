/**
 * 뉴니콘 관리자 운영 설정 API
 * GET   /api/admin/settings             전체 설정 조회
 * PATCH /api/admin/settings             특정 설정 수정
 */
export const config = { runtime: 'edge' };

import { verifyAdmin, ok, err, handleOptions, logAudit } from './auth.js';

// 수정 가능한 설정 키와 타입 정의 (admin 전용)
const ALLOWED_SETTINGS = {
  'free_daily_quota':           { type: 'integer', min: 1, max: 100, adminOnly: false },
  'member_daily_quota':         { type: 'integer', min: 1, max: 1000, adminOnly: false },
  'ai_model':                   { type: 'string',  allowedValues: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5'], adminOnly: true },
  'ai_max_tokens':              { type: 'integer', min: 100, max: 4000, adminOnly: true },
  'risk_keywords_high':         { type: 'json_array', adminOnly: false },
  'risk_keywords_caution':      { type: 'json_array', adminOnly: false },
  'maintenance_mode':           { type: 'boolean', adminOnly: true },
  'maintenance_message':        { type: 'string', maxLen: 500, adminOnly: true },
  'ai_disclaimer_text':         { type: 'string', maxLen: 1000, adminOnly: false },
  'min_app_version':            { type: 'string', adminOnly: true },
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();

  const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
  if (errorResponse) return errorResponse;

  if (req.method === 'GET')   return getSettings(supaAdmin);
  if (req.method === 'PATCH') return updateSetting(supaAdmin, adminUser, req);

  return err(405, '허용되지 않는 메서드');
}

async function getSettings(supaAdmin) {
  const { data, error } = await supaAdmin
    .from('operation_settings')
    .select('key, value, description, updated_at, updated_by')
    .order('key');

  if (error) return err(500, '설정 조회 오류');

  // key: value 맵으로 변환
  const settings = {};
  for (const row of (data ?? [])) {
    settings[row.key] = {
      value: row.value,
      description: row.description,
      updated_at: row.updated_at,
    };
  }

  return ok({ settings, allowed_keys: Object.keys(ALLOWED_SETTINGS) });
}

async function updateSetting(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { key, value, change_note } = body;
  if (!key) return err(400, 'key가 필요합니다');
  if (value === undefined) return err(400, 'value가 필요합니다');

  // 허용 키 확인
  const spec = ALLOWED_SETTINGS[key];
  if (!spec) return err(400, `'${key}'는 수정할 수 없는 설정입니다`);

  // admin 전용 설정은 admin 역할만 수정 가능
  if (spec.adminOnly && adminUser.role !== 'admin') {
    return err(403, `'${key}'는 최고 관리자(admin)만 수정할 수 있습니다`);
  }

  // 값 유효성 검사
  const validated = validateValue(key, value, spec);
  if (validated.error) return err(400, validated.error);

  // 기존 값 조회
  const { data: before } = await supaAdmin
    .from('operation_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  // upsert 방식으로 저장
  const { error } = await supaAdmin
    .from('operation_settings')
    .upsert({
      key,
      value: validated.value,
      updated_at: new Date().toISOString(),
      updated_by: adminUser.id,
    }, { onConflict: 'key' });

  if (error) return err(500, '설정 업데이트 오류: ' + error.message);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'setting_update',
    targetType: 'operation_setting',
    targetId: key,
    beforeValue: { value: before?.value },
    afterValue: { value: validated.value, change_note },
  });

  return ok({ success: true, key, value: validated.value });
}

function validateValue(key, value, spec) {
  switch (spec.type) {
    case 'integer': {
      const n = parseInt(value);
      if (isNaN(n)) return { error: `${key}: 정수 값이 필요합니다` };
      if (spec.min !== undefined && n < spec.min) return { error: `${key}: 최솟값은 ${spec.min}입니다` };
      if (spec.max !== undefined && n > spec.max) return { error: `${key}: 최댓값은 ${spec.max}입니다` };
      return { value: n };
    }
    case 'boolean': {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        return { error: `${key}: true 또는 false 값이 필요합니다` };
      }
      return { value: value === true || value === 'true' };
    }
    case 'string': {
      const s = String(value);
      if (spec.allowedValues && !spec.allowedValues.includes(s)) {
        return { error: `${key}: 허용 값 [${spec.allowedValues.join(', ')}] 중 하나여야 합니다` };
      }
      if (spec.maxLen && s.length > spec.maxLen) {
        return { error: `${key}: 최대 ${spec.maxLen}자까지 허용됩니다` };
      }
      return { value: s };
    }
    case 'json_array': {
      let arr;
      try {
        arr = typeof value === 'string' ? JSON.parse(value) : value;
      } catch {
        return { error: `${key}: 유효한 JSON 배열이 필요합니다` };
      }
      if (!Array.isArray(arr)) return { error: `${key}: 배열 형식이 필요합니다` };
      return { value: arr };
    }
    default:
      return { value };
  }
}
