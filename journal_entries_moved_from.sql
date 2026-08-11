-- Provenance for entries moved between journals.
ALTER TABLE public.journal_entries
ADD COLUMN IF NOT EXISTS moved_from jsonb;
