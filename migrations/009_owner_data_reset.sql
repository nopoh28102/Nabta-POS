-- A data reset is an owner-confirmed maintenance operation.  Normal business
-- routes remain unable to alter or delete ledger records.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('nabta.data_reset_authorized', true) = '1' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'immutable ledger row';
END;
$$;

INSERT INTO schema_migrations(version) VALUES ('009_owner_data_reset')
ON CONFLICT (version) DO NOTHING;
