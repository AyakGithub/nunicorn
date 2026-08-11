/**
 * 뉴니콘 관리자 API 공통 인증 미들웨어
 * 모든 관리자 API에서 import해서 사용합니다.
 *
 * 사용법:
 *   const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
 *   if (errorResponse) return errorResponse;
 */

const SUPA_URL = process.env.SUPA_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
};

/**
 * 관리자 권한 검증
 * @param {Request} req
 * @returns {{ adminUser, supaAdmin, errorResponse }}
 */
export async function verifyAdmin(req) {
  // 서비스 롤 키 확인
  if (!SUPA_SERVICE_KEY) {
    console.error('[admin] SUPABASE_SERVICE_ROLE_KEY not configured');
    return { errorResponse: err(503, '서버 설정 오류') };
  }

  // Authorization 헤더에서 JWT 추출
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!jwt) {
    return { errorResponse: err(401, '인증이 필요합니다') };
  }

  // Supabase 서비스 롤 클라이언트 초기화
  const supaAdmin = createSupabaseAdmin();

  // JWT로 사용자 확인
  const { data: { user }, error: authError } = await supaAdmin.auth.getUser(jwt);
  if (authError || !user) {
    return { errorResponse: err(401, '유효하지 않은 인증 정보입니다') };
  }

  // user_roles 테이블에서 관리자 권한 확인
  const { data: roleData, error: roleError } = await supaAdmin
    .from('user_roles')
    .select('role, is_active')
    .eq('user_id', user.id)
    .in('role', ['admin', 'moderator'])
    .eq('is_active', true)
    .maybeSingle();

  if (roleError || !roleData) {
    return { errorResponse: err(403, '관리자 권한이 없습니다') };
  }

  return { adminUser: { ...user, role: roleData.role }, supaAdmin };
}

/**
 * Supabase 서비스 롤 클라이언트 생성 (서버 전용)
 */
export function createSupabaseAdmin() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(SUPA_URL, SUPA_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/**
 * 감사 로그 기록
 */
export async function logAudit(supaAdmin, {
  adminUserId, actionType, targetType, targetId,
  beforeValue, afterValue, metadata = {}, success = true, errorMessage
}) {
  try {
    await supaAdmin.from('admin_audit_logs').insert({
      admin_user_id: adminUserId,
      action_type: actionType,
      target_type: targetType,
      target_id: String(targetId ?? ''),
      before_value: beforeValue ?? null,
      after_value: afterValue ?? null,
      metadata,
      success,
      error_message: errorMessage ?? null,
    });
  } catch (e) {
    console.error('[admin] audit log failed:', e.message);
  }
}

/**
 * 페이지네이션 파라미터 파싱
 */
export function parsePagination(url) {
  const params = new URL(url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '20')));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * 오류 응답 생성
 */
export function err(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}

/**
 * 성공 응답 생성
 */
export function ok(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

/**
 * CORS preflight 처리
 */
export function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}
