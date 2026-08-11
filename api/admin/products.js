/**
 * 뉴니콘 관리자 제품 DB API
 * GET    /api/admin/products           목록
 * GET    /api/admin/products?id=uuid   상세 (영양성분 포함)
 * POST   /api/admin/products           생성
 * PUT    /api/admin/products           수정 (버전 스냅샷 저장)
 * DELETE /api/admin/products           비활성화 (영구 삭제 아님)
 */
export const config = { runtime: 'edge' };

import { verifyAdmin, ok, err, handleOptions, parsePagination, logAudit } from './auth.js';

// 중복 요청 방지 (Edge 함수 메모리 기반, 재시작 시 초기화)
const recentRequests = new Map();

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();

  const { adminUser, supaAdmin, errorResponse } = await verifyAdmin(req);
  if (errorResponse) return errorResponse;

  const url = new URL(req.url);

  if (req.method === 'GET' && url.searchParams.get('id')) {
    return getDetail(supaAdmin, url.searchParams.get('id'));
  }
  if (req.method === 'GET') return getList(supaAdmin, url);
  if (req.method === 'POST')   return createProduct(supaAdmin, adminUser, req);
  if (req.method === 'PUT')    return updateProduct(supaAdmin, adminUser, req);
  if (req.method === 'DELETE') return deactivateProduct(supaAdmin, adminUser, req);

  return err(405, '허용되지 않는 메서드');
}

async function getList(supaAdmin, url) {
  const { limit, offset } = parsePagination(url.toString());
  const p = url.searchParams;

  let query = supaAdmin
    .from('products')
    .select('id,brand,product_name,product_type,is_children,is_active,data_review_status,last_reviewed_at,version,created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (p.get('brand'))   query = query.ilike('brand', `%${p.get('brand')}%`);
  if (p.get('keyword')) query = query.ilike('product_name', `%${p.get('keyword')}%`);
  if (p.get('is_active') !== null && p.get('is_active') !== '') {
    query = query.eq('is_active', p.get('is_active') === 'true');
  }
  if (p.get('status'))  query = query.eq('data_review_status', p.get('status'));

  const { data, count, error } = await query;
  if (error) return err(500, '조회 오류');
  return ok({ items: data ?? [], total: count ?? 0, limit, offset });
}

async function getDetail(supaAdmin, id) {
  const [productRes, nutrientsRes] = await Promise.all([
    supaAdmin.from('products').select('*').eq('id', id).maybeSingle(),
    supaAdmin.from('product_nutrients').select('*').eq('product_id', id),
  ]);
  if (!productRes.data) return err(404, '제품을 찾을 수 없습니다');
  return ok({ product: productRes.data, nutrients: nutrientsRes.data ?? [] });
}

async function createProduct(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { product, nutrients = [], idempotency_key } = body;
  if (!product?.brand || !product?.product_name) {
    return err(400, '브랜드와 제품명은 필수입니다');
  }

  // 중복 요청 방지
  if (idempotency_key) {
    if (recentRequests.has(idempotency_key)) {
      return err(409, '동일한 요청이 이미 처리되었습니다');
    }
    recentRequests.set(idempotency_key, true);
    setTimeout(() => recentRequests.delete(idempotency_key), 60000);
  }

  // DB 레벨 중복 확인 (브랜드+제품명+버전)
  const version = product.version || 1;
  const { data: existing } = await supaAdmin
    .from('products')
    .select('id')
    .eq('brand', product.brand)
    .eq('product_name', product.product_name)
    .eq('version', version)
    .maybeSingle();

  if (existing) {
    return err(409, '동일한 브랜드·제품명·버전이 이미 존재합니다. 버전 번호를 확인하세요.');
  }

  // 음수 값 검증
  if (nutrients.some(n => parseFloat(n.amount_per_serving) < 0)) {
    return err(400, '영양성분 함량은 0 이상이어야 합니다');
  }

  // 제품 저장
  const { data: newProduct, error: pErr } = await supaAdmin
    .from('products')
    .insert({ ...product, version, is_active: false })
    .select()
    .single();

  if (pErr) return err(500, '제품 생성 오류: ' + pErr.message);

  // 영양성분 저장
  if (nutrients.length > 0) {
    const rows = nutrients.map(n => ({ ...n, product_id: newProduct.id }));
    await supaAdmin.from('product_nutrients').insert(rows);
  }

  // 버전 스냅샷 저장
  await saveSnapshot(supaAdmin, newProduct.id, version, { product: newProduct, nutrients }, adminUser.id, '초기 등록');

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'product_create',
    targetType: 'product',
    targetId: newProduct.id,
    afterValue: { brand: product.brand, product_name: product.product_name, version },
  });

  return ok({ product: newProduct }, 201);
}

async function updateProduct(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }

  const { id, product, nutrients, change_note = '' } = body;
  if (!id) return err(400, 'id가 필요합니다');

  // 기존 제품 조회
  const { data: before } = await supaAdmin.from('products').select('*').eq('id', id).maybeSingle();
  if (!before) return err(404, '제품을 찾을 수 없습니다');

  // 단위 변환 오류 방지: 단위가 바뀌면 경고
  if (nutrients) {
    for (const n of nutrients) {
      if (n.amount_per_serving < 0) return err(400, `${n.nutrient_name}: 함량은 0 이상이어야 합니다`);
    }
  }

  // 제품 업데이트
  const newVersion = (before.version || 1) + 1;
  const updateData = { ...product, version: newVersion, updated_at: new Date().toISOString() };

  const { error: uErr } = await supaAdmin.from('products').update(updateData).eq('id', id);
  if (uErr) return err(500, '업데이트 오류: ' + uErr.message);

  // 영양성분 교체
  if (nutrients) {
    await supaAdmin.from('product_nutrients').delete().eq('product_id', id);
    if (nutrients.length > 0) {
      const rows = nutrients.map(n => ({ ...n, product_id: id }));
      await supaAdmin.from('product_nutrients').insert(rows);
    }
  }

  // 버전 스냅샷 저장
  const { data: updatedNutrients } = await supaAdmin.from('product_nutrients').select('*').eq('product_id', id);
  await saveSnapshot(supaAdmin, id, newVersion, { product: { ...before, ...updateData }, nutrients: updatedNutrients ?? [] }, adminUser.id, change_note);

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'product_update',
    targetType: 'product',
    targetId: id,
    beforeValue: { version: before.version },
    afterValue: { version: newVersion, change_note },
  });

  return ok({ success: true, new_version: newVersion });
}

async function deactivateProduct(supaAdmin, adminUser, req) {
  let body;
  try { body = await req.json(); } catch { return err(400, '잘못된 요청 형식'); }
  const { id, reason = '' } = body;
  if (!id) return err(400, 'id가 필요합니다');

  const { error } = await supaAdmin.from('products').update({ is_active: false }).eq('id', id);
  if (error) return err(500, '비활성화 오류');

  await logAudit(supaAdmin, {
    adminUserId: adminUser.id,
    actionType: 'product_deactivate',
    targetType: 'product',
    targetId: id,
    afterValue: { reason },
  });

  return ok({ success: true });
}

async function saveSnapshot(supaAdmin, productId, version, data, changedBy, note) {
  await supaAdmin.from('product_versions').insert({
    product_id: productId,
    version,
    snapshot: data,
    changed_by: changedBy,
    change_note: note,
  });
}
