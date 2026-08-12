// 임시 마이그레이션 엔드포인트 — 1회 사용 후 삭제
// GET /api/admin/migrate-once?token=nunicorn-migrate-2026

export const config = { runtime: 'edge' };

const MIGRATION_TOKEN = 'nunicorn-migrate-2026';

const MIGRATION_SQL = `
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'moderator')),
  granted_by uuid references auth.users(id),
  granted_at timestamptz default now(),
  is_active boolean default true,
  note text default '',
  unique(user_id, role)
);
alter table public.user_roles enable row level security;
create policy if not exists "user_roles_svc" on public.user_roles for all using (false);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null,
  action_type text not null,
  target_type text,
  target_id text,
  before_value jsonb,
  after_value jsonb,
  metadata jsonb default '{}',
  success boolean default true,
  error_message text,
  created_at timestamptz default now()
);
alter table public.admin_audit_logs enable row level security;
create policy if not exists "audit_svc" on public.admin_audit_logs for all using (false);

create table if not exists public.chat_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  question text not null,
  answer text,
  child_age_label text,
  child_months int,
  supplements_context text,
  status text not null default 'pending'
    check (status in ('success','failed','timeout','empty_reply','pending')),
  error_code text,
  quota_deducted boolean default false,
  risk_level text default 'normal'
    check (risk_level in ('normal','caution','high')),
  risk_flags text[] default '{}',
  review_status text default 'pending'
    check (review_status in ('pending','reviewing','normal','needs_revision','dangerous','completed')),
  reviewer_id uuid references auth.users(id) on delete set null,
  reviewer_note text,
  disclaimer_shown boolean default true,
  user_agent text,
  created_at timestamptz default now()
);
alter table public.chat_logs enable row level security;
create policy if not exists "chat_read" on public.chat_logs for select using (auth.uid() = user_id);
create policy if not exists "chat_insert_svc" on public.chat_logs for insert with check (false);

create table if not exists public.reviewed_answers (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  sub_topic text,
  trigger_keywords text not null,
  answer_text text not null,
  source_chat_id uuid references public.chat_logs(id) on delete set null,
  notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  version int default 1,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.reviewed_answers enable row level security;
create policy if not exists "ra_read" on public.reviewed_answers for select using (is_active = true);
create policy if not exists "ra_svc" on public.reviewed_answers for all using (false);

create table if not exists public.reviewed_answer_versions (
  id uuid primary key default gen_random_uuid(),
  reviewed_answer_id uuid not null references public.reviewed_answers(id) on delete cascade,
  version int not null,
  answer_text text,
  changed_by uuid references auth.users(id) on delete set null,
  change_note text,
  created_at timestamptz default now()
);
alter table public.reviewed_answer_versions enable row level security;
create policy if not exists "rav_svc" on public.reviewed_answer_versions for all using (false);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  product_name text not null,
  product_type text,
  is_children boolean default true,
  is_active boolean default false,
  version int default 1,
  data_review_status text default 'draft'
    check (data_review_status in ('draft','reviewed','published')),
  last_reviewed_at timestamptz,
  internal_note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(brand, product_name, version)
);
alter table public.products enable row level security;
create policy if not exists "prod_read" on public.products for select using (is_active = true);
create policy if not exists "prod_svc" on public.products for all using (false);

create table if not exists public.product_nutrients (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  nutrient_name text not null,
  amount_per_serving numeric not null check (amount_per_serving >= 0),
  unit text not null,
  created_at timestamptz default now()
);
alter table public.product_nutrients enable row level security;
create policy if not exists "pn_read" on public.product_nutrients for select using (
  exists (select 1 from public.products p where p.id = product_id and p.is_active = true)
);
create policy if not exists "pn_svc" on public.product_nutrients for all using (false);

create table if not exists public.product_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  changed_by uuid references auth.users(id) on delete set null,
  change_note text,
  created_at timestamptz default now()
);
alter table public.product_versions enable row level security;
create policy if not exists "pv_svc" on public.product_versions for all using (false);

create table if not exists public.nutrition_references (
  id uuid primary key default gen_random_uuid(),
  nutrient_key text not null,
  age_group_label text not null,
  age_min_months int,
  age_max_months int,
  recommended_intake numeric,
  upper_limit numeric,
  unit text not null,
  kdri_year int default 2025,
  notes text,
  updated_at timestamptz default now(),
  created_at timestamptz default now(),
  unique(nutrient_key, age_group_label)
);
alter table public.nutrition_references enable row level security;
create policy if not exists "nr_read" on public.nutrition_references for select using (true);
create policy if not exists "nr_svc" on public.nutrition_references for all using (false);

create table if not exists public.operation_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.operation_settings enable row level security;
create policy if not exists "os_read" on public.operation_settings for select using (true);
create policy if not exists "os_svc" on public.operation_settings for all using (false);

insert into public.operation_settings (key, value, description) values
  ('free_daily_quota',    '3',     '비회원 하루 무료 상담 횟수'),
  ('member_daily_quota',  '10',    '회원 하루 상담 횟수'),
  ('ai_model',            '"claude-haiku-4-5-20251001"', 'AI 모델명'),
  ('ai_max_tokens',       '512',   'AI 최대 토큰'),
  ('maintenance_mode',    'false', '점검 모드'),
  ('maintenance_message', '""',    '점검 안내 메시지'),
  ('ai_disclaimer_text',  '"뉴니콘의 AI 안내는 참고용 정보이며, 의료진의 진단·처방을 대신하지 않습니다."', 'AI 면책 문구'),
  ('min_app_version',     '"1.0.0"', '최소 지원 앱 버전')
on conflict (key) do nothing;

create table if not exists public.quota_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  adjustment int not null,
  reason text not null default '',
  adjusted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
alter table public.quota_adjustments enable row level security;
create policy if not exists "qa_svc" on public.quota_adjustments for all using (false);

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'user_roles','admin_audit_logs','chat_logs','reviewed_answers',
    'reviewed_answer_versions','products','product_nutrients',
    'product_versions','nutrition_references','operation_settings','quota_adjustments'
  )
order by table_name;
`;

export default async function handler(req) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');

  if (token !== MIGRATION_TOKEN) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPA_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supaUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'env vars missing', supaUrl: !!supaUrl, serviceKey: !!serviceKey }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Supabase REST API를 통해 SQL 실행
  const resp = await fetch(`${supaUrl}/rest/v1/rpc/exec_migration`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ sql: MIGRATION_SQL })
  });

  // exec_migration 함수가 없으면 pg_net 방식 시도
  if (!resp.ok) {
    // 직접 SQL 실행 엔드포인트 시도
    const resp2 = await fetch(`${supaUrl}/rest/v1/`, {
      method: 'GET',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      }
    });

    // Supabase pg-meta API 경로 시도
    const pgMetaResp = await fetch(`${supaUrl.replace('supabase.co', 'supabase.co')}/pg-meta/v0/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ query: MIGRATION_SQL })
    });

    if (pgMetaResp.ok) {
      const result = await pgMetaResp.json();
      return new Response(JSON.stringify({ success: true, via: 'pg-meta', result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const errText = await resp.text();
    return new Response(JSON.stringify({
      error: 'migration failed',
      status: resp.status,
      detail: errText.substring(0, 500)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const result = await resp.json();
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
