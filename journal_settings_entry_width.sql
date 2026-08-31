-- Optional: run in the Supabase SQL editor so entry width syncs across devices.
alter table public.journal_settings
  add column if not exists entry_width integer not null default 0;

alter table public.journal_settings
  drop constraint if exists journal_settings_entry_width_check;

alter table public.journal_settings
  add constraint journal_settings_entry_width_check
  check (entry_width >= 0 and entry_width <= 100);
