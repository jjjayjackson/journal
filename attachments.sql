-- Ecosystem-wide attachments: files live in Storage; metadata + owner links live in Postgres.
-- Owner records stay app-specific (drafts_drafts, todo_inbox_items, todo_tasks, journal_entries).
-- Transfers relink the same attachment_id; they do not copy Storage objects.

CREATE TABLE IF NOT EXISTS public.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_size bigint,
  original_filename text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attachment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid NOT NULL REFERENCES public.attachments(id) ON DELETE CASCADE,
  owner_type text NOT NULL,
  owner_id text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS attachment_links_owner_idx
  ON public.attachment_links (owner_type, owner_id, position);

CREATE INDEX IF NOT EXISTS attachment_links_attachment_id_idx
  ON public.attachment_links (attachment_id);

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_select_attachments ON public.attachments;
DROP POLICY IF EXISTS anon_insert_attachments ON public.attachments;
DROP POLICY IF EXISTS anon_update_attachments ON public.attachments;
DROP POLICY IF EXISTS anon_delete_attachments ON public.attachments;
CREATE POLICY anon_select_attachments ON public.attachments
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY anon_insert_attachments ON public.attachments
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY anon_update_attachments ON public.attachments
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY anon_delete_attachments ON public.attachments
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_select_attachment_links ON public.attachment_links;
DROP POLICY IF EXISTS anon_insert_attachment_links ON public.attachment_links;
DROP POLICY IF EXISTS anon_update_attachment_links ON public.attachment_links;
DROP POLICY IF EXISTS anon_delete_attachment_links ON public.attachment_links;
CREATE POLICY anon_select_attachment_links ON public.attachment_links
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY anon_insert_attachment_links ON public.attachment_links
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY anon_update_attachment_links ON public.attachment_links
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY anon_delete_attachment_links ON public.attachment_links
  FOR DELETE TO anon, authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.attachments TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attachment_links TO anon, authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('attachments', 'attachments', true, 20971520)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS anon_select_attachments_objects ON storage.objects;
DROP POLICY IF EXISTS anon_insert_attachments_objects ON storage.objects;
DROP POLICY IF EXISTS anon_update_attachments_objects ON storage.objects;
DROP POLICY IF EXISTS anon_delete_attachments_objects ON storage.objects;

CREATE POLICY anon_select_attachments_objects ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'attachments');
CREATE POLICY anon_insert_attachments_objects ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'attachments');
CREATE POLICY anon_update_attachments_objects ON storage.objects
  FOR UPDATE TO anon, authenticated
  USING (bucket_id = 'attachments')
  WITH CHECK (bucket_id = 'attachments');
CREATE POLICY anon_delete_attachments_objects ON storage.objects
  FOR DELETE TO anon, authenticated
  USING (bucket_id = 'attachments');
