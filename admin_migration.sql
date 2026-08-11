-- ============================================================
-- 뉴니콘 관리자 패널 DB 마이그레이션
-- Supabase Dashboard → SQL Editor에서 실행하세요
-- 기존 데이터는 보존됩니다. 새 테이블만 추가합니다.
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. user_roles — 관리자 권한 테이블
-- ──────────────────────────────────────────────────────────
create table if not exists public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('admin', 'moderator')),
  granted_by  uuid references auth.users(id),
  granted_at  timestamptz default now(),
  is_active   boolean default true,
  note        text default '',
  unique(user_id, role)
);

alter table public.user_roles enable row level security;

-- 서비스 롤(서버)만 읽기 가능, 일반 사용자 접근 불가
create policy "user_roles: 서비스 롤만 접근" on public.user_roles
  for all using (false);

-- 관리자 권한 부여 방법:
-- Supabase Dashboard → SQL Editor에서 직접 실행:
-- INSERT INTO public.user_roles (user_id, role, note)
-- VALUES ('실제-user-uuid', 'admin', '초기 관리자');

-- ──────────────────────────────────────────────────────────
-- 2. admin_audit_logs — 관리자 작업 감사 로그
-- ──────────────────────────────────────────────────────────
create table if not exists public.admin_audit_logs (
  id             uuid primary key default gen_random_uuid(),
  admin_user_id  uuid not null,
  action_type    text not null, -- 'quota_adjust','review_update','product_create','answer_update' 등
  target_type    text,          -- 'user','chat_log','product','reviewed_answer','setting'
  target_id      text,
  before_value   jsonb,
  after_value    jsonb,
  metadata       jsonb default '{}',
  success        boolean default true,
  error_message  text,
  created_at     timestamptz default now()
);

alter table public.admin_audit_logs enable row level security;

create policy "audit_logs: 서비스 롤만 접근" on public.admin_audit_logs
  for all using (false);

create index if not exists audit_logs_admin_idx on public.admin_audit_logs(admin_user_id, created_at desc);
create index if not exists audit_logs_target_idx on public.admin_audit_logs(target_type, target_id);

-- ──────────────────────────────────────────────────────────
-- 3. chat_logs — AI 상담 기록 (신규: 현재 저장 안 됨)
-- ──────────────────────────────────────────────────────────
create table if not exists public.chat_logs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete set null,
  session_key         text,           -- 비회원 식별용 (해시)
  question            text not null,
  answer              text,
  child_age_label     text,
  child_months        int,
  supplements_context jsonb default '[]',
  model_name          text default 'claude-haiku-4-5-20251001',
  prompt_version      text default 'v1',
  status              text not null default 'pending'
                        check (status in ('success','failed','timeout','empty_reply')),
  error_code          text,
  quota_deducted      boolean default false,
  risk_level          text default 'normal'
                        check (risk_level in ('normal','caution','high')),
  risk_flags          text[] default '{}',
  review_status       text default 'pending'
                        check (review_status in ('pending','reviewing','normal','needs_revision','dangerous','completed')),
  reviewer_id         uuid references auth.users(id) on delete set null,
  reviewer_note       text,
  disclaimer_shown    boolean default true,
  is_duplicate        boolean default false,
  created_at          timestamptz default now()
);

alter table public.chat_logs enable row level security;

-- 본인 상담 기록만 읽기 가능
create policy "chat_logs: 본인만 읽기" on public.chat_logs
  for select using (auth.uid() = user_id);

-- 삽입은 서버(서비스 롤)만 허용 — anon/인증 사용자는 직접 삽입 불가
create policy "chat_logs: 서비스 롤만 쓰기" on public.chat_logs
  for insert with check (false);

create index if not exists chat_logs_user_idx on public.chat_logs(user_id, created_at desc);
create index if not exists chat_logs_status_idx on public.chat_logs(status, created_at desc);
create index if not exists chat_logs_risk_idx on public.chat_logs(risk_level, review_status, created_at desc);

-- ──────────────────────────────────────────────────────────
-- 4. reviewed_answers — 검수 답변 관리
-- ──────────────────────────────────────────────────────────
create table if not exists public.reviewed_answers (
  id                  uuid primary key default gen_random_uuid(),
  question_pattern    text not null,
  answer              text not null,
  brand               text,
  product_name        text,
  age_min_months      int,
  age_max_months      int,
  related_nutrients   text[] default '{}',
  topic               text, -- '섭취량','섭취시간','병용','성분중복','보관','이상반응' 등
  risk_level          text default 'normal' check (risk_level in ('normal','caution','high')),
  is_active           boolean default true,
  author_id           uuid references auth.users(id) on delete set null,
  reviewer_id         uuid references auth.users(id) on delete set null,
  review_status       text default 'draft'
                        check (review_status in ('draft','pending_review','reviewed','inactive')),
  reviewed_at         timestamptz,
  source              text,
  internal_note       text,
  version             int default 1,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

alter table public.reviewed_answers enable row level security;

-- 활성화된 검수 답변만 일반 사용자에게 공개 (향후 AI 연동용)
create policy "reviewed_answers: 활성 항목 읽기" on public.reviewed_answers
  for select using (is_active = true and review_status = 'reviewed');

create policy "reviewed_answers: 서비스 롤만 쓰기" on public.reviewed_answers
  for all using (false);

create index if not exists reviewed_answers_active_idx
  on public.reviewed_answers(is_active, review_status);

-- ──────────────────────────────────────────────────────────
-- 5. reviewed_answer_versions — 검수 답변 버전 이력
-- ──────────────────────────────────────────────────────────
create table if not exists public.reviewed_answer_versions (
  id               uuid primary key default gen_random_uuid(),
  answer_id        uuid not null references public.reviewed_answers(id) on delete cascade,
  version          int not null,
  question_pattern text,
  answer           text,
  changed_by       uuid references auth.users(id) on delete set null,
  change_note      text,
  snapshot         jsonb default '{}', -- 전체 스냅샷
  created_at       timestamptz default now()
);

alter table public.reviewed_answer_versions enable row level security;

create policy "reviewed_answer_versions: 서비스 롤만" on public.reviewed_answer_versions
  for all using (false);

create index if not exists rav_answer_idx on public.reviewed_answer_versions(answer_id, version desc);

-- ──────────────────────────────────────────────────────────
-- 6. products — 제품 DB
-- ──────────────────────────────────────────────────────────
create table if not exists public.products (
  id                  uuid primary key default gen_random_uuid(),
  brand               text not null,
  product_name        text not null,
  product_type        text,
  is_children         boolean default true,
  is_active           boolean default false, -- 검수 완료 후 활성화
  image_url           text,
  label_image_url     text,
  total_content       text,
  serving_size        text,
  age_min_months      int,
  age_max_months      int,
  recommended_intake  text,
  intake_method       text,
  warnings            text,
  allergy_info        text,
  storage_method      text,
  manufacturer        text,
  version             int default 1,
  data_review_status  text default 'draft'
                        check (data_review_status in ('draft','reviewed','published')),
  last_reviewed_at    timestamptz,
  internal_note       text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique(brand, product_name, version)
);

alter table public.products enable row level security;

-- 활성화된 제품만 일반 사용자에게 공개
create policy "products: 활성 항목 읽기" on public.products
  for select using (is_active = true);

create policy "products: 서비스 롤만 쓰기" on public.products
  for all using (false);

create index if not exists products_brand_idx on public.products(brand, is_active);

-- ──────────────────────────────────────────────────────────
-- 7. product_nutrients — 제품 영양성분
-- ──────────────────────────────────────────────────────────
create table if not exists public.product_nutrients (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.products(id) on delete cascade,
  nutrient_key        text not null, -- 'vitD','zinc','iron' 등 내부 키
  nutrient_name       text not null,
  amount_per_serving  numeric not null check (amount_per_serving >= 0),
  unit                text not null,
  servings_per_day    int default 1 check (servings_per_day > 0),
  daily_total         numeric,
  form                text, -- 원료 형태
  source_label        text, -- 라벨 표기 원문
  created_at          timestamptz default now()
);

alter table public.product_nutrients enable row level security;

create policy "product_nutrients: 활성 제품 읽기" on public.product_nutrients
  for select using (
    exists (select 1 from public.products p where p.id = product_id and p.is_active = true)
  );

create policy "product_nutrients: 서비스 롤만 쓰기" on public.product_nutrients
  for all using (false);

create index if not exists pn_product_idx on public.product_nutrients(product_id);

-- ──────────────────────────────────────────────────────────
-- 8. product_versions — 제품 버전 이력 스냅샷
-- ──────────────────────────────────────────────────────────
create table if not exists public.product_versions (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  version     int not null,
  snapshot    jsonb not null, -- 해당 버전의 전체 제품+영양성분 스냅샷
  changed_by  uuid references auth.users(id) on delete set null,
  change_note text,
  created_at  timestamptz default now()
);

alter table public.product_versions enable row level security;

create policy "product_versions: 서비스 롤만" on public.product_versions
  for all using (false);

create index if not exists pv_product_idx on public.product_versions(product_id, version desc);

-- ──────────────────────────────────────────────────────────
-- 9. nutrition_references — KDRIs 영양 기준 데이터
-- ──────────────────────────────────────────────────────────
create table if not exists public.nutrition_references (
  id                  uuid primary key default gen_random_uuid(),
  nutrient_key        text not null,
  nutrient_name       text not null,
  age_min_months      int not null,
  age_max_months      int not null,
  gender              text default 'all' check (gender in ('all','male','female')),
  recommended_amount  numeric, -- 권장섭취량(RNI) 또는 충분섭취량(AI)
  adequate_intake     numeric, -- 충분섭취량(AI) — 별도 표기 필요시
  upper_limit         numeric, -- 상한섭취량(UL)
  unit                text not null,
  reference_type      text check (reference_type in ('RNI','AI','UL','EAR')),
  source              text,    -- '보건복지부·한국영양학회'
  source_year         int,     -- 2025
  effective_from      date,
  is_active           boolean default true,
  admin_note          text,
  version_label       text,    -- 'KDRIs 2025'
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique(nutrient_key, age_min_months, age_max_months, gender, source_year)
);

alter table public.nutrition_references enable row level security;

-- 활성 기준만 공개
create policy "nutrition_references: 활성 읽기" on public.nutrition_references
  for select using (is_active = true);

create policy "nutrition_references: 서비스 롤만 쓰기" on public.nutrition_references
  for all using (false);

-- ──────────────────────────────────────────────────────────
-- 10. operation_settings — 운영 설정
-- ──────────────────────────────────────────────────────────
create table if not exists public.operation_settings (
  key          text primary key,
  value        text not null,
  value_type   text default 'string' check (value_type in ('string','number','boolean','json')),
  description  text,
  is_sensitive boolean default false, -- 민감 설정은 UI에서 마스킹
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz default now()
);

alter table public.operation_settings enable row level security;

-- 민감하지 않은 설정만 공개 (프론트에서 동적으로 로드 가능)
create policy "settings: 비민감 읽기" on public.operation_settings
  for select using (is_sensitive = false);

create policy "settings: 서비스 롤만 쓰기" on public.operation_settings
  for all using (false);

-- 기본 운영 설정 값 삽입
insert into public.operation_settings (key, value, value_type, description) values
  ('free_daily_limit',   '3',                           'number',  '비회원 하루 무료 AI 상담 횟수'),
  ('member_daily_limit', '10',                          'number',  '회원 하루 AI 상담 횟수'),
  ('chat_enabled',       'true',                        'boolean', 'AI 상담 기능 활성 여부'),
  ('support_email',      'help@nunicorn.co.kr',         'string',  '고객 문의 이메일'),
  ('disclaimer_text',    '뉴니콘의 분석과 AI 안내는 영양정보 제공을 위한 참고 자료이며, 의료진의 진단이나 처방을 대신하지 않습니다. 질환이 있거나 의약품을 복용 중인 경우 의사 또는 약사와 상담해 주세요.',
                                                         'string',  'AI 상담 면책 안내'),
  ('supported_brands',   '["베투키","아약키즈"]',        'json',    '주력 지원 브랜드'),
  ('maintenance_mode',   'false',                       'boolean', '점검 모드'),
  ('maintenance_msg',    '',                            'string',  '점검 안내 메시지')
on conflict (key) do nothing;

-- ──────────────────────────────────────────────────────────
-- 11. user_reports — 사용자 신고·피드백
-- ──────────────────────────────────────────────────────────
create table if not exists public.user_reports (
  id           uuid primary key default gen_random_uuid(),
  chat_log_id  uuid references public.chat_logs(id) on delete set null,
  user_id      uuid references auth.users(id) on delete set null,
  report_type  text not null
                 check (report_type in ('wrong_answer','irrelevant','dangerous','wrong_product_info','hard_to_understand','other')),
  description  text,
  admin_note   text,
  status       text default 'pending'
                 check (status in ('pending','reviewing','resolved','dismissed')),
  resolved_by  uuid references auth.users(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz default now()
);

alter table public.user_reports enable row level security;

create policy "user_reports: 본인만 쓰기" on public.user_reports
  for insert with check (auth.uid() = user_id);

create policy "user_reports: 서비스 롤만 전체 접근" on public.user_reports
  for all using (false);

-- ──────────────────────────────────────────────────────────
-- 12. quota_adjustments — 잔여 횟수 조정 감사 로그
-- ──────────────────────────────────────────────────────────
create table if not exists public.quota_adjustments (
  id              uuid primary key default gen_random_uuid(),
  target_user_id  uuid not null references auth.users(id) on delete cascade,
  admin_user_id   uuid not null references auth.users(id),
  adjustment      int not null,         -- 양수: 증가, 음수: 감소
  reason          text not null,
  before_value    int,
  after_value     int,
  idempotency_key text unique,          -- 중복 조정 방지
  created_at      timestamptz default now()
);

alter table public.quota_adjustments enable row level security;

create policy "quota_adjustments: 서비스 롤만" on public.quota_adjustments
  for all using (false);

create index if not exists qa_target_idx on public.quota_adjustments(target_user_id, created_at desc);

-- ──────────────────────────────────────────────────────────
-- 완료 확인 쿼리
-- ──────────────────────────────────────────────────────────
-- select table_name from information_schema.tables
-- where table_schema = 'public'
-- order by table_name;
