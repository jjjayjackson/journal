-- Provenance for entries copied between journals.
ALTER TABLE public.journal_entries
ADD COLUMN IF NOT EXISTS copied_from jsonb;
