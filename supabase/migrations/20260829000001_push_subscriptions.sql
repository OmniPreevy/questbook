-- ─────────────────────────────────────────────────────────────────────
-- push_subscriptions
-- One row per device/browser that is signed in as a given user. The
-- "permanent link" a device gets when it subscribes to Web Push is its
-- `endpoint`. When another device changes data, the send-push Edge
-- Function POSTs to every endpoint for that user so the closed device's
-- service worker is woken immediately.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  device_name text,
  created_at  timestamptz not null default now(),
  last_ping_at timestamptz,
  unique (user_id, endpoint)
);

comment on table public.push_subscriptions is
  'Web Push subscription endpoints per user, used to wake closed devices on data change.';

-- The service worker stores which subscription it used so the app can
-- exclude itself when notifying the user's other devices.
alter table public.push_subscriptions
  add column if not exists endpoint_hash text;

-- A user can read/manage their own subscriptions (so the client can list
-- and clean up stale ones). All writes/per-user reads for pushing are done
-- by the Edge Function with the service_role key, which bypasses RLS.
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions select own" on public.push_subscriptions;
create policy "push_subscriptions select own"
  on public.push_subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "push_subscriptions insert own" on public.push_subscriptions;
create policy "push_subscriptions insert own"
  on public.push_subscriptions for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "push_subscriptions delete own" on public.push_subscriptions;
create policy "push_subscriptions delete own"
  on public.push_subscriptions for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "push_subscriptions update own" on public.push_subscriptions;
create policy "push_subscriptions update own"
  on public.push_subscriptions for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
