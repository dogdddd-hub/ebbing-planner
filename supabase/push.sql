-- 폰 푸시 알림용 테이블
-- Supabase 대시보드 → SQL Editor 에 붙여 넣고 Run 하세요. 여러 번 실행해도 괜찮습니다.
-- (예약 실행 설정은 비밀값이 들어가서 이 파일에 없습니다. 따로 받은 SQL로 실행하세요.)

-- 알림을 받을 기기 목록
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  tz         text not null default 'Asia/Seoul',
  ua         text,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "본인 기기 읽기" on public.push_subscriptions;
drop policy if exists "본인 기기 추가" on public.push_subscriptions;
drop policy if exists "본인 기기 수정" on public.push_subscriptions;
drop policy if exists "본인 기기 삭제" on public.push_subscriptions;
create policy "본인 기기 읽기" on public.push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "본인 기기 추가" on public.push_subscriptions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "본인 기기 수정" on public.push_subscriptions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "본인 기기 삭제" on public.push_subscriptions for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- 하루에 같은 알림을 두 번 보내지 않도록 기록 (서버 함수만 사용)
create table if not exists public.push_sent (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     text not null,
  slot    text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, day, slot)
);
alter table public.push_sent enable row level security;
revoke all on public.push_sent from anon, authenticated;

-- 5분마다 함수를 부르는 데 필요한 확장
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 서버 함수(service_role)가 쓰는 최소 권한: 기록 읽기, 기기 목록 읽기·정리, 발송 기록
grant select on public.records to service_role;
grant select, delete on public.push_subscriptions to service_role;
grant select, insert, delete on public.push_sent to service_role;
