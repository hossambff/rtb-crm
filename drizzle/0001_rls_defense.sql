-- Defense in depth: enable RLS on every table in schema rso. The app connects as the owning role (rso_app),
-- which bypasses RLS; anon/authenticated (PostgREST) have no schema usage and no policies → no access.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'rso' LOOP
    EXECUTE format('ALTER TABLE rso.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
