/**
 * 뉴니콘 관리자 API 공통 인증 미들웨어
 * fetch 기반 Supabase 클라이언트 (supabase-js npm 의존성 없음)
 */

const SUPA_URL = process.env.SUPA_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
};

// ─────────────────────────────────────────────────────────────────
// fetch 기반 Supabase 클라이언트 (supabase-js 대체)
// ─────────────────────────────────────────────────────────────────

export function createSupabaseAdmin() {
  const BASE_HEADERS = {
    'apikey': SUPA_SERVICE_KEY,
    'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  function from(table) {
    const filters = [];
    let _select = '*';
    let _isCountHead = false;
    let _limit = null;
    let _offset = null;
    const _orderParts = [];

    const buildQuery = () => {
      const parts = [];
      if (!_isCountHead) parts.push(`select=${encodeURIComponent(_select)}`);
      parts.push(...filters);
      parts.push(..._orderParts);
      if (_limit !== null) parts.push(`limit=${_limit}`);
      if (_offset !== null) parts.push(`offset=${_offset}`);
      return parts.join('&');
    };

    const doFetch = async (method = 'GET', body = null, extraHeaders = {}) => {
      const q = buildQuery();
      const url = `${SUPA_URL}/rest/v1/${table}${q ? '?' + q : ''}`;
      const headers = { ...BASE_HEADERS, ...extraHeaders };
      if (_isCountHead) headers['Prefer'] = 'count=exact';

      const res = await fetch(url, {
        method: _isCountHead ? 'HEAD' : method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
      });

      if (_isCountHead) {
        if (!res.ok) return { data: null, count: 0, error: { status: res.status } };
        const range = res.headers.get('Content-Range'); // e.g. "0-9/42" or "*/42"
        const total = range ? parseInt(range.split('/')[1] || '0') : 0;
        return { data: null, count: isNaN(total) ? 0 : total, error: null };
      }
      if (!res.ok) {
        let error;
        try { error = await res.json(); } catch { error = { status: res.status }; }
        return { data: null, count: null, error };
      }
      let data;
      try { data = await res.json(); } catch { data = null; }
      return { data, count: null, error: null };
    };

    const chain = {
      select(cols, opts = {}) {
        _select = cols;
        if (opts.count === 'exact' && opts.head === true) _isCountHead = true;
        return chain;
      },
      eq(col, val) {
        filters.push(`${col}=eq.${encodeURIComponent(val)}`);
        return chain;
      },
      neq(col, val) {
        filters.push(`${col}=neq.${encodeURIComponent(val)}`);
        return chain;
      },
      in(col, vals) {
        filters.push(`${col}=in.(${vals.map(v => encodeURIComponent(v)).join(',')})`);
        return chain;
      },
      gte(col, val) {
        filters.push(`${col}=gte.${encodeURIComponent(val)}`);
        return chain;
      },
      lte(col, val) {
        filters.push(`${col}=lte.${encodeURIComponent(val)}`);
        return chain;
      },
      like(col, val) {
        filters.push(`${col}=like.${encodeURIComponent(val)}`);
        return chain;
      },
      ilike(col, val) {
        filters.push(`${col}=ilike.${encodeURIComponent(val)}`);
        return chain;
      },
      order(col, { ascending = true } = {}) {
        _orderParts.push(`order=${col}.${ascending ? 'asc' : 'desc'}`);
        return chain;
      },
      limit(n) { _limit = n; return chain; },
      range(from, to) {
        _offset = from;
        _limit = to - from + 1;
        return chain;
      },
      async maybeSingle() {
        _limit = 1;
        const { data, error } = await doFetch();
        if (error) return { data: null, error };
        const arr = Array.isArray(data) ? data : (data ? [data] : []);
        return { data: arr[0] ?? null, error: null };
      },
      async single() {
        _limit = 1;
        const { data, error } = await doFetch();
        if (error) return { data: null, error };
        const arr = Array.isArray(data) ? data : (data ? [data] : []);
        if (!arr.length) return { data: null, error: { message: 'Not found', code: 'PGRST116' } };
        return { data: arr[0], error: null };
      },
      insert(body, opts = {}) {
        const prefer = opts.onConflict
          ? 'resolution=merge-duplicates,return=representation'
          : 'return=representation';
        return doFetch('POST', body, { 'Prefer': prefer });
      },
      update(body) {
        return doFetch('PATCH', body, { 'Prefer': 'return=representation' });
      },
      delete() {
        return doFetch('DELETE');
      },
      then(resolve, reject) {
        return doFetch().then(resolve, reject);
      },
      catch(fn) {
        return doFetch().then(r => r).catch(fn);
      },
    };
    return chain;
  }

  const auth = {
    async getUser(jwt) {
      const res = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'apikey': SUPA_SERVICE_KEY,
        }
      });
      if (!res.ok) return { data: { user: null }, error: { status: res.status } };
      let user;
      try { user = await res.json(); } catch { user = null; }
      return { data: { user }, error: null };
    }
  };

  return { from, auth };
}

// ─────────────────────────────────────────────────────────────────
// 관리자 권한 검증
// ─────────────────────────────────────────────────────────────────

export async function verifyAdmin(req) {
  if (!SUPA_SERVICE_KEY) {
    console.error('[admin] SUPABASE_SERVICE_ROLE_KEY not configured');
    return { errorResponse: err(503, '서버 설정 오류') };
  }

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return { errorResponse: err(401, '인증이 필요합니다') };

  const supaAdmin = createSupabaseAdmin();
  const { data: { user }, error: authError } = await supaAdmin.auth.getUser(jwt);
  if (authError || !user) return { errorResponse: err(401, '유효하지 않은 인증 정보입니다') };

  const { data: roleData, error: roleError } = await supaAdmin
    .from('user_roles')
    .select('role, is_active')
    .eq('user_id', user.id)
    .in('role', ['admin', 'moderator'])
    .eq('is_active', true)
    .maybeSingle();

  if (roleError || !roleData) return { errorResponse: err(403, '관리자 권한이 없습니다') };

  return { adminUser: { ...user, role: roleData.role }, supaAdmin };
}

// ─────────────────────────────────────────────────────────────────
// 감사 로그
// ─────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

export function parsePagination(url) {
  const params = new URL(url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '20')));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function err(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}

export function ok(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

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
