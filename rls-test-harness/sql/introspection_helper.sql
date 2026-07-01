-- Optional helper function so the audit script can check, via the
-- service-role key, whether RLS is actually enabled on a given table.
-- Without this, the harness can still run every anon-key and cross-user
-- probe; this function only powers the "rls-enabled" check.
--
-- Run this once against your project (SQL editor in the Supabase dashboard,
-- or `psql` with a connection string that has DDL privileges). It is safe
-- to run on any project: it only reads catalog metadata and takes a table
-- name as input, it does not touch your actual data.
--
-- Security note: this function is SECURITY DEFINER so it can read
-- pg_class regardless of the caller's own privileges, but it only exposes
-- a boolean (RLS enabled or not) for a table name the caller already
-- knows, which is not sensitive information on its own.
--
-- Hardening note: SECURITY DEFINER functions are a classic
-- search_path-hijacking target. If `search_path` includes a schema an
-- unprivileged user can create objects in (e.g. `public`, by default),
-- that user could create a same-named object that shadows a catalog
-- object the function relies on, and have the function silently operate
-- on the attacker's object instead of the real one. This function avoids
-- that entirely by setting `search_path = ''` (empty) and fully
-- qualifying every catalog reference with `pg_catalog.`, so there is
-- nothing left for a hijacked search_path to redirect. It also takes the
-- schema as an explicit parameter rather than assuming `public`, and uses
-- `to_regclass` (which returns NULL for a name that doesn't resolve to a
-- real, existing relation) instead of a bare cast, which would raise an
-- error on a typo'd or non-existent table name.

create or replace function rls_hardening_kit_check_rls_enabled(
  p_table_name text,
  p_schema_name text default 'public'
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select c.relrowsecurity
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.oid = pg_catalog.to_regclass(
          pg_catalog.format('%I.%I', p_schema_name, p_table_name)
        )
    and n.nspname = p_schema_name
    and c.relkind = 'r';
$$;

-- Lock the function down to service_role only; anon/authenticated should
-- never be able to call this directly (even though it only returns a
-- boolean, there is no reason to expose it beyond the audit tool itself).
revoke all on function rls_hardening_kit_check_rls_enabled(text, text) from public;
grant execute on function rls_hardening_kit_check_rls_enabled(text, text) to service_role;

-- To remove this helper after you're done auditing:
-- drop function if exists rls_hardening_kit_check_rls_enabled(text, text);
