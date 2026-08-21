-- Provenance for entries transferred from other apps (e.g. Capture → River).
ALTER TABLE public.journal_entries
ADD COLUMN IF NOT EXISTS transferred_from jsonb;
