-- 복습 플래너 동기화 테이블
-- Supabase 대시보드 → SQL Editor 에 붙여 넣고 Run 하세요. 여러 번 실행해도 괜찮습니다.

create table if not exists public.records (
  user_id    uuid   not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text   not null check (kind in ('item', 'log', 'settings', 'task')),
  id         text   not null,
  data       jsonb  not null,
  updated_at bigint not null,                       -- 기기에서 고친 시각 (병합 기준)
  server_at  timestamptz not null default now(),    -- 서버에 들어온 시각 (받기 기준)
  primary key (user_id, kind, id)
);
-- 2026-11-22 '할 일'(task) 추가: 이미 만든 표도 새 종류를 받도록
alter table public.records drop constraint if exists records_kind_check;
alter table public.records add constraint records_kind_check check (kind in ('item', 'log', 'settings', 'task'));
create index if not exists records_user_server_at on public.records (user_id, server_at);

-- 서버에 들어온 시각은 항상 서버가 기록
create or replace function public.records_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.server_at := now();
  return new;
end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.records_touch();

-- 보안 규칙: 로그인한 본인 기록만 읽고 쓸 수 있음 (지우기는 허용하지 않음 — 앱은 삭제 표시만 씀)
alter table public.records enable row level security;
drop policy if exists "본인 기록 읽기" on public.records;
drop policy if exists "본인 기록 추가" on public.records;
drop policy if exists "본인 기록 수정" on public.records;
create policy "본인 기록 읽기" on public.records for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "본인 기록 추가" on public.records for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "본인 기록 수정" on public.records for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 로그인하지 않은 접근(anon)은 아예 권한 없음
revoke all on public.records from anon;
grant select, insert, update on public.records to authenticated;
