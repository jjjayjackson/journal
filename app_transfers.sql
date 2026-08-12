-- Cross-app transfer ledger for idempotent moves (retry-safe).
CREATE TABLE IF NOT EXISTS public.app_transfers (
  id uuid PRIMARY KEY,
  source_app text NOT NULL,
  destination_app text NOT NULL,
  source_entry_id text NOT NULL,
  content text NOT NULL,
  source_created_at timestamptz NOT NULL,
  transferred_at timestamptz NOT NULL,
  destination_entry_id uuid,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_transfers_destination_entry_id_idx
  ON public.app_transfers (destination_entry_id);

ALTER TABLE public.app_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_select_app_transfers ON public.app_transfers;
DROP POLICY IF EXISTS anon_insert_app_transfers ON public.app_transfers;
DROP POLICY IF EXISTS anon_update_app_transfers ON public.app_transfers;
DROP POLICY IF EXISTS anon_delete_app_transfers ON public.app_transfers;

CREATE POLICY anon_select_app_transfers ON public.app_transfers
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY anon_insert_app_transfers ON public.app_transfers
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY anon_update_app_transfers ON public.app_transfers
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY anon_delete_app_transfers ON public.app_transfers
  FOR DELETE TO anon, authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_transfers TO anon, authenticated;
