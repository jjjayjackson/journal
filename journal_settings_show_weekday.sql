-- Optional: run in the Supabase SQL editor so show_weekday syncs across devices.
alter table public.journal_settings
  add column if not exists show_weekday boolean not null default false;
