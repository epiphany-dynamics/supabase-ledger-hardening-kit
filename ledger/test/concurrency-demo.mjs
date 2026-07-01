#!/usr/bin/env node
// Concurrency demo: proves the naive deduction function allows a double
// spend under real concurrent load, and proves the hardened version
// (SELECT ... FOR UPDATE) does not, using the same inputs and the same
// artificial network-latency delay for both.
//
// This is intentionally a plain Node script using the `pg` driver rather
// than a mocked test, because the entire point is to exercise real
// concurrent connections against a real Postgres backend. Mocking the
// database would hide the exact bug this kit exists to demonstrate.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const CONNECTION_STRING =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';
const STARTING_BALANCE_CENTS = 10000; // $100.00, matches 00_schema.sql / 03_reset.sql
const DEDUCTION_CENTS = 6000; // $60.00 -- two concurrent deductions of this size
                               // must not both succeed against a $100 balance
const CONCURRENT_REQUESTS = 2;

const pool = new Pool({ connectionString: CONNECTION_STRING });

function readSql(filename) {
  return readFileSync(join(__dirname, '..', 'sql', filename), 'utf8');
}

async function setup() {
  const client = await pool.connect();
  try {
    await client.query(readSql('00_schema.sql'));
    await client.query(readSql('01_naive_deduct.sql'));
    await client.query(readSql('02_hardened_deduct.sql'));
  } finally {
    client.release();
  }
}

async function resetAccount() {
  const client = await pool.connect();
  try {
    await client.query(readSql('03_reset.sql'));
  } finally {
    client.release();
  }
}

async function getBalance() {
  const { rows } = await pool.query(
    'select balance_cents from accounts where id = $1',
    [ACCOUNT_ID],
  );
  return Number(rows[0].balance_cents);
}

// Fire N concurrent calls to the given SQL function, each on its own
// connection, so Postgres genuinely interleaves them rather than the
// requests being serialized by a single connection's protocol.
async function fireConcurrentDeductions(fnName, n) {
  const calls = Array.from({ length: n }, async (_, i) => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `select * from ${fnName}($1, $2, $3)`,
        [ACCOUNT_ID, DEDUCTION_CENTS, `concurrency-demo-${fnName}-${i}`],
      );
      return rows[0];
    } finally {
      client.release();
    }
  });
  return Promise.all(calls);
}

function printResult(label, results, finalBalance) {
  const successCount = results.filter((r) => r.ok).length;
  const expectedFinal = STARTING_BALANCE_CENTS - successCount * DEDUCTION_CENTS;
  const correct = finalBalance === expectedFinal && finalBalance >= 0;

  console.log(`\n--- ${label} ---`);
  console.log(`Starting balance:     $${(STARTING_BALANCE_CENTS / 100).toFixed(2)}`);
  console.log(`Deduction per call:   $${(DEDUCTION_CENTS / 100).toFixed(2)}`);
  console.log(`Concurrent requests:  ${results.length}`);
  results.forEach((r, i) => {
    console.log(
      `  request[${i}]: ok=${r.ok}  new_balance=${
        r.new_balance_cents === null ? 'n/a' : `$${(Number(r.new_balance_cents) / 100).toFixed(2)}`
      }  message="${r.message}"`,
    );
  });
  console.log(`Requests that succeeded: ${successCount}`);
  console.log(`Expected final balance (if correct): $${(expectedFinal / 100).toFixed(2)}`);
  console.log(`Actual final balance in DB:           $${(finalBalance / 100).toFixed(2)}`);
  console.log(
    correct
      ? `RESULT: CORRECT - balance matches successful-deduction count, never negative.`
      : `RESULT: BUG - balance does not match successful-deduction count (double-spend), or went negative.`,
  );
  return correct;
}

async function main() {
  console.log('Setting up schema and functions...');
  await setup();

  // --- Naive version ---
  await resetAccount();
  const naiveResults = await fireConcurrentDeductions('naive_deduct', CONCURRENT_REQUESTS);
  const naiveFinalBalance = await getBalance();
  const naiveCorrect = printResult('NAIVE deduct (no locking)', naiveResults, naiveFinalBalance);

  // --- Hardened version ---
  await resetAccount();
  const hardenedResults = await fireConcurrentDeductions('hardened_deduct', CONCURRENT_REQUESTS);
  const hardenedFinalBalance = await getBalance();
  const hardenedCorrect = printResult(
    'HARDENED deduct (SELECT ... FOR UPDATE)',
    hardenedResults,
    hardenedFinalBalance,
  );

  console.log('\n=== Summary ===');
  console.log(
    `Naive version:    ${naiveCorrect ? 'passed (unexpected, race did not trigger this run)' : 'FAILED as expected (race condition demonstrated)'}`,
  );
  console.log(`Hardened version: ${hardenedCorrect ? 'passed (correct under concurrency)' : 'FAILED (unexpected, investigate)'}`);

  await pool.end();

  // Exit non-zero only if the hardened version failed to hold the
  // invariant: that's the one that actually must never fail. The naive
  // version failing is the expected, demonstrated behavior, not a bug in
  // this script.
  if (!hardenedCorrect) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal error running concurrency demo:', err);
  process.exitCode = 1;
});
