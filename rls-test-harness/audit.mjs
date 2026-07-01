#!/usr/bin/env node
// Generic Row-Level-Security audit harness for any Supabase project.
//
// This does NOT know your schema in advance. You give it a list of tables
// to probe (via config or CLI args), and for each table it runs a checklist
// of read/write probes using the anon key and, if provided, a second
// "other user" JWT, to look for the standard RLS misconfiguration classes:
//
//   1. Anon can read a table that should require authentication.
//   2. Anon can write (insert/update/delete) a table at all.
//   3. An authenticated user can read another user's row(s) in a table
//      that has an ownership column (e.g. user_id), meaning the SELECT
//      policy is missing an `auth.uid() = owner_column` predicate.
//   4. An authenticated user can update or delete another user's row(s),
//      meaning the UPDATE/DELETE policy's USING clause is missing or wrong.
//   5. RLS is not enabled on the table at all (service-role introspection
//      query against pg_tables / pg_class.relrowsecurity).
//
// This is a real audit tool, not a fixture demo: point it at any Supabase
// project via env vars and it will tell you what it found. It is
// intentionally conservative: every probe is read-only by default unless
// you pass --allow-write-probes, because probes 2 and 4 above involve
// attempting a write against a real project's real data.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const ALLOW_WRITE_PROBES = args.includes('--allow-write-probes');
const CONFIG_PATH = (() => {
  const flagIndex = args.indexOf('--config');
  if (flagIndex !== -1 && args[flagIndex + 1]) return args[flagIndex + 1];
  return join(__dirname, 'tables.example.json');
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // optional, enables deeper checks
const OTHER_USER_JWT = process.env.SUPABASE_OTHER_USER_JWT; // optional, a second real user's access token

if (!SUPABASE_URL || !ANON_KEY) {
  console.error(
    'Missing required env vars. Set SUPABASE_URL and SUPABASE_ANON_KEY (see .env.example).',
  );
  process.exit(1);
}

if (!existsSync(CONFIG_PATH)) {
  console.error(`Config file not found: ${CONFIG_PATH}`);
  console.error('Copy rls-test-harness/tables.example.json to tables.json and edit it,');
  console.error('or pass --config /path/to/your-tables.json');
  process.exit(1);
}

const tableConfigs = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const anonClient = createClient(SUPABASE_URL, ANON_KEY);
const otherUserClient = OTHER_USER_JWT
  ? createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${OTHER_USER_JWT}` } },
    })
  : null;
const serviceClient = SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY) : null;

const results = [];

function record(table, probe, severity, passed, detail) {
  results.push({ table, probe, severity, passed, detail });
}

// --- Probe 1: anon read access -------------------------------------------
async function probeAnonRead(table, cfg) {
  const { data, error } = await anonClient.from(table).select('*').limit(1);
  if (cfg.expectAnonReadable) {
    // This table is intentionally public (e.g. a public product catalog).
    record(
      table,
      'anon-read',
      'info',
      true,
      error ? `expected public, but anon read errored: ${error.message}` : 'anon read allowed (expected: table marked public in config)',
    );
    return;
  }
  if (error) {
    record(table, 'anon-read', 'pass', true, `anon read blocked: ${error.message}`);
  } else {
    const rowCount = Array.isArray(data) ? data.length : 0;
    record(
      table,
      'anon-read',
      'critical',
      rowCount === 0,
      rowCount === 0
        ? 'anon read returned zero rows (likely RLS filtering correctly, or table is empty; verify with service role)'
        : `anon read returned ${rowCount} row(s) from a table NOT marked public in config`,
    );
  }
}

// --- Probe 2: anon write access ------------------------------------------
async function probeAnonWrite(table, cfg) {
  if (!ALLOW_WRITE_PROBES) {
    record(table, 'anon-write', 'skipped', null, 'write probes disabled (pass --allow-write-probes to enable)');
    return;
  }
  const probeRow = cfg.writeProbeRow || { id: '00000000-0000-0000-0000-000000000000' };
  const { error } = await anonClient.from(table).insert(probeRow).select();
  if (error) {
    record(table, 'anon-write', 'pass', true, `anon insert blocked: ${error.message}`);
  } else {
    record(
      table,
      'anon-write',
      'critical',
      false,
      'anon insert SUCCEEDED. Anon key can write to this table; check INSERT policy / WITH CHECK clause.',
    );
    // Best-effort cleanup if we have service role.
    if (serviceClient && probeRow.id) {
      await serviceClient.from(table).delete().eq('id', probeRow.id);
    }
  }
}

// --- Probe 3 & 4: cross-user read / write via ownership column ----------
async function probeCrossUserAccess(table, cfg) {
  if (!otherUserClient) {
    record(
      table,
      'cross-user-access',
      'skipped',
      null,
      'SUPABASE_OTHER_USER_JWT not set; cannot test cross-user isolation without a second real user session',
    );
    return;
  }
  if (!cfg.ownerColumn || !cfg.knownOtherUserRowId) {
    record(
      table,
      'cross-user-access',
      'skipped',
      null,
      'config missing ownerColumn / knownOtherUserRowId for this table; cannot target a specific other-user row',
    );
    return;
  }

  const { data: readData, error: readError } = await otherUserClient
    .from(table)
    .select('*')
    .eq('id', cfg.knownOtherUserRowId)
    .maybeSingle();

  if (readError) {
    record(table, 'cross-user-read', 'pass', true, `cross-user read blocked: ${readError.message}`);
  } else if (!readData) {
    record(table, 'cross-user-read', 'pass', true, 'cross-user read returned no row (policy correctly scoped)');
  } else {
    record(
      table,
      'cross-user-read',
      'critical',
      false,
      `authenticated user read another user's row (id=${cfg.knownOtherUserRowId}). SELECT policy is likely missing an auth.uid() = ${cfg.ownerColumn} predicate.`,
    );
  }

  if (!ALLOW_WRITE_PROBES) {
    record(table, 'cross-user-write', 'skipped', null, 'write probes disabled (pass --allow-write-probes to enable)');
    return;
  }

  if (!cfg.writeProbeField || cfg.writeProbeValue === undefined) {
    record(
      table,
      'cross-user-write',
      'skipped',
      null,
      'config missing writeProbeField / writeProbeValue for this table; refusing to guess a column to write to. ' +
        'NEVER point this at ownerColumn: overwriting a row\'s owner column is destructive even when the probe ' +
        '"succeeds" as designed, since it would reassign the row to a different user.',
    );
    return;
  }

  // Capture the row's current value for the probe field first, using the
  // service-role client if available, so we can restore it if the update
  // unexpectedly succeeds. If no service role key was provided, we still
  // run the probe (its result is still meaningful) but skip the
  // restore step and say so in the finding.
  let originalValue;
  let preReadError;
  if (serviceClient) {
    const { data: beforeRow, error } = await serviceClient
      .from(table)
      .select(cfg.writeProbeField)
      .eq('id', cfg.knownOtherUserRowId)
      .maybeSingle();
    preReadError = error;
    originalValue = beforeRow ? beforeRow[cfg.writeProbeField] : undefined;
  }

  // Critical detail: under PostgREST/Supabase, an UPDATE whose WHERE clause
  // matches a row that RLS then filters out of the *result set* comes back
  // with `error: null` and zero affected rows, NOT an error. If we only
  // checked `error`, a correctly-scoped policy (row filtered, nothing
  // updated) would look identical to "the update quietly succeeded but
  // returned nothing," and this probe would need to guess which one
  // happened. Requesting `.select()` on the update forces PostgREST to
  // return the actual updated row(s), so we can tell the difference
  // directly: zero rows back = correctly blocked, one row back = the
  // policy let an unauthorized write through.
  const { data: updatedRows, error: writeError } = await otherUserClient
    .from(table)
    .update({ [cfg.writeProbeField]: cfg.writeProbeValue })
    .eq('id', cfg.knownOtherUserRowId)
    .select('id');

  if (writeError) {
    record(table, 'cross-user-write', 'pass', true, `cross-user update blocked: ${writeError.message}`);
    return;
  }

  const rowWasActuallyUpdated = Array.isArray(updatedRows) && updatedRows.length > 0;

  if (!rowWasActuallyUpdated) {
    record(
      table,
      'cross-user-write',
      'pass',
      true,
      'cross-user update matched zero rows (RLS correctly filtered the target row out of the update; no error, but nothing was actually changed)',
    );
    return;
  }

  let restoreNote;
  if (!serviceClient) {
    restoreNote = 'service role key not provided, could not auto-restore the original value; check this row manually';
  } else if (preReadError) {
    restoreNote = `could not auto-restore: pre-read via service role failed (${preReadError.message}); check this row manually`;
  } else if (originalValue === undefined) {
    restoreNote = 'could not auto-restore: pre-read via service role returned no row for this id; check this row manually';
  } else {
    const { error: restoreError } = await serviceClient
      .from(table)
      .update({ [cfg.writeProbeField]: originalValue })
      .eq('id', cfg.knownOtherUserRowId);
    restoreNote = restoreError
      ? `attempted to restore original value but the restore itself failed (${restoreError.message}); check this row manually`
      : 'original value restored via service role';
  }

  record(
    table,
    'cross-user-write',
    'critical',
    false,
    `authenticated user was able to run an UPDATE against another user's row (id=${cfg.knownOtherUserRowId}, ` +
      `field=${cfg.writeProbeField}). UPDATE policy's USING clause is likely missing or wrong. (${restoreNote})`,
  );
}

// --- Probe 5: RLS enabled at all (requires service role) ----------------
async function probeRlsEnabled(table) {
  if (!serviceClient) {
    record(table, 'rls-enabled', 'skipped', null, 'SUPABASE_SERVICE_ROLE_KEY not set; cannot introspect pg_class.relrowsecurity');
    return;
  }
  const { data, error } = await serviceClient.rpc('rls_hardening_kit_check_rls_enabled', {
    p_table_name: table,
  });
  if (error) {
    record(
      table,
      'rls-enabled',
      'skipped',
      null,
      `could not check (did you run rls-test-harness/sql/introspection_helper.sql on this project? error: ${error.message})`,
    );
    return;
  }
  const enabled = data === true;
  record(
    table,
    'rls-enabled',
    'critical',
    enabled,
    enabled ? 'RLS is enabled on this table' : 'RLS IS NOT ENABLED on this table. Any policy is meaningless until RLS is turned on.',
  );
}

async function main() {
  console.log(`Auditing ${Object.keys(tableConfigs).length} table(s) at ${SUPABASE_URL}`);
  console.log(`Write probes: ${ALLOW_WRITE_PROBES ? 'ENABLED' : 'disabled (read-only run)'}`);
  console.log(`Service role checks: ${serviceClient ? 'enabled' : 'disabled (no service role key)'}`);
  console.log(`Cross-user checks: ${otherUserClient ? 'enabled' : 'disabled (no other-user JWT)'}\n`);

  for (const [table, cfg] of Object.entries(tableConfigs)) {
    await probeRlsEnabled(table);
    await probeAnonRead(table, cfg);
    await probeAnonWrite(table, cfg);
    await probeCrossUserAccess(table, cfg);
  }

  console.log('\n=== RLS Audit Report ===\n');
  const bySeverityOrder = { critical: 0, pass: 1, info: 2, skipped: 3 };
  results
    .slice()
    .sort((a, b) => bySeverityOrder[a.severity] - bySeverityOrder[b.severity])
    .forEach((r) => {
      const tag = {
        critical: '[FAIL]',
        pass: '[ OK ]',
        info: '[INFO]',
        skipped: '[SKIP]',
      }[r.severity];
      console.log(`${tag} ${r.table} :: ${r.probe} -> ${r.detail}`);
    });

  const failures = results.filter((r) => r.severity === 'critical' && r.passed === false);
  console.log(`\n${failures.length} finding(s) requiring attention out of ${results.length} probe(s) run.`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal error running RLS audit:', err);
  process.exitCode = 1;
});
