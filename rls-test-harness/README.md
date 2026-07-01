# RLS Test Harness

A runnable audit tool for Row-Level-Security misconfigurations on any real
Supabase project. Point it at your project via environment variables, tell
it which tables to look at via a small JSON config, and it runs a checklist
of probes that mirror the most common ways RLS quietly fails to do what
everyone assumed it did.

This is not a demo against a fixture schema. It talks to a real Supabase
project over the real REST API using the real anon key (and, if you provide
them, a service-role key and a second test user's JWT), exactly the way an
attacker or a buggy client would.

**Status:** the probe logic (including the PostgREST zero-rows-vs-error
handling described below) has been verified by code review against
documented PostgREST/Supabase semantics, but has not yet been smoke-tested
end-to-end against a live Supabase project in this environment. Run it once
against a staging project and confirm the findings match expectations before
relying on it as a CI gate.

## What it checks

| Probe | What it catches |
|---|---|
| `rls-enabled` | RLS was never turned on for the table at all (requires service-role key + the included introspection helper) |
| `anon-read` | The anon key can read rows from a table that isn't supposed to be public |
| `anon-write` | The anon key can INSERT into the table at all (see note below: this checks INSERT specifically, not UPDATE/DELETE) |
| `cross-user-read` | An authenticated user can read another user's row (SELECT policy missing or wrong `auth.uid()` predicate) |
| `cross-user-write` | An authenticated user can update another user's row via a harmless, config-provided field (UPDATE policy `USING` clause missing or wrong) |

**Note on `anon-write`:** this probe specifically attempts an `INSERT`. It
does not attempt `UPDATE` or `DELETE` against arbitrary rows, because doing
so safely would require already knowing a row to target, which is exactly
what the cross-user probes below are for. If you need to verify anon UPDATE/
DELETE are blocked on a specific table, add a `writeProbeField` /
`writeProbeValue` pair to that table's config, run with
`--allow-write-probes`, and rely on `cross-user-write`, calling it with the
anon client's own JWT if you want an "anon vs. any real row" variant rather
than a "user A vs. user B" variant.

Each finding is tagged `critical`, `pass`, `info`, or `skipped`, and the
script exits non-zero if any `critical` finding fails, so it's usable as a
CI gate, not just an interactive tool.

## Setup

```bash
npm install
cp rls-test-harness/.env.example .env
# fill in SUPABASE_URL and SUPABASE_ANON_KEY at minimum

cp rls-test-harness/tables.example.json rls-test-harness/tables.json
# edit tables.json to describe YOUR tables (see below)
```

### Describing your tables

`tables.json` maps table name -> probe configuration:

```json
{
  "profiles": {
    "expectAnonReadable": false,
    "ownerColumn": "user_id",
    "knownOtherUserRowId": "a-real-uuid-owned-by-a-different-test-user",
    "writeProbeField": "display_name",
    "writeProbeValue": "rls-audit-probe-value"
  },
  "public_products": {
    "expectAnonReadable": true
  }
}
```

- `expectAnonReadable`: set `true` for genuinely public tables (a product
  catalog, public listings) so the harness doesn't flag intentional public
  reads as findings.
- `ownerColumn` / `knownOtherUserRowId`: needed only for the cross-user
  probes. Point `knownOtherUserRowId` at a real row in a seed/test dataset
  that belongs to a **different** user than whichever JWT you put in
  `SUPABASE_OTHER_USER_JWT`. Never point this at real customer data; use a
  staging project or dedicated test accounts.
- `writeProbeField` / `writeProbeValue`: required for the `cross-user-write`
  probe. Pick a harmless, non-owner column (a display name, a notes field,
  anything that isn't load-bearing for the row's identity or ownership) and
  a throwaway value. **Never set this to the owner column** (`user_id`,
  `customer_id`, etc.): even in the "probe succeeded, meaning the bug
  exists" case, writing to the owner column would reassign that row to a
  different user, which is a destructive side effect independent of the
  audit's own findings. The probe requests the updated row back
  (`.select('id')` on the update) specifically because PostgREST returns
  `error: null` with zero rows, not an error, when RLS filters the target
  row out of an UPDATE's result set; without checking the actual returned
  rows, a correctly-scoped policy and a silently-no-op'd write would look
  identical. If a service-role key is configured, the harness captures the
  field's original value before the probe and restores it automatically if
  the write unexpectedly succeeds (and reports explicitly if the pre-read
  or the restore itself fails); without a service-role key it still runs
  the probe but cannot auto-restore, and says so in the finding.
- `writeProbeRow`: only used by the `anon-write` (INSERT) probe when you
  pass `--allow-write-probes`. Give it a row shape that satisfies your
  table's NOT NULL columns so a failed insert is because of RLS, not a
  schema mismatch.

### Enabling the deeper checks (optional)

- **RLS-enabled check:** run `rls-test-harness/sql/introspection_helper.sql`
  once against your project (Supabase SQL editor or `psql`), then set
  `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
- **Cross-user checks:** sign in as a second real test user in your app (or
  via `supabase.auth.signInWithPassword`), grab `session.access_token`, and
  set it as `SUPABASE_OTHER_USER_JWT`.

Both are optional. Without them, the harness still runs the anon-read and
anon-write probes, which catch the most common and most severe class of
misconfiguration: data reachable with no authentication at all.

## Running it

```bash
# Read-only run (safe on a production project): anon-read + rls-enabled only
node rls-test-harness/audit.mjs

# Full run including write probes (use a staging project, not production)
node rls-test-harness/audit.mjs --allow-write-probes

# Point at a different config file
node rls-test-harness/audit.mjs --config ./my-tables.json
```

Or via the root `package.json` script:

```bash
npm run rls:audit
```

## Safety notes

- **Write probes are off by default.** `anon-write` and `cross-user-write`
  are skipped unless you pass `--allow-write-probes`, because they attempt
  a real insert/update against a real project. Run write probes against a
  staging project or a project seeded with disposable test data, not a
  live production database with real customer rows.
- **This tool never modifies policies.** It only reads results and reports
  findings; fixing a misconfigured policy is a deliberate, reviewed change
  you make yourself.
- **Treat the service-role key like a root password.** It bypasses RLS
  entirely. Only ever put it in a `.env` file that's gitignored, and only
  run this tool from a trusted machine, never from a client/browser
  context.

## Interpreting results

A `[FAIL]` on `anon-read` or `anon-write` for a table that isn't supposed to
be public is the highest-severity finding this tool produces: it means data
is reachable with nothing more than the public anon key, which is shipped
in every client bundle. A `[FAIL]` on `cross-user-read` or `cross-user-write`
means the policy exists and technically restricts anon, but doesn't
correctly scope access between two different authenticated users, which
usually traces back to a missing or misspelled `auth.uid() = <column>`
predicate, or a `USING` clause on the SELECT policy that isn't mirrored by a
`WITH CHECK` clause on the corresponding UPDATE/INSERT policy.
