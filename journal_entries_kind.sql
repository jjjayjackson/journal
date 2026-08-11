-- System/announcement entries (e.g. journal rename notices).
ALTER TABLE public.journal_entries
ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'entry';

ALTER TABLE public.journal_entries
DROP CONSTRAINT IF EXISTS journal_entries_kind_check;

ALTER TABLE public.journal_entries
ADD CONSTRAINT journal_entries_kind_check
CHECK (kind IN ('entry', 'announcement'));
