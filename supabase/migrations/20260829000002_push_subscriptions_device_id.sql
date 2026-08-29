-- Add a stable per-device identifier to push_subscriptions so the account
-- owner can revoke specific devices (sign out all OTHER devices) and the
-- app can gate its own sync on whether it has been revoked.
alter table public.push_subscriptions add column if not exists device_id text;

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);
