#!/usr/bin/env node
// Minimal HTTP wrapper around the ledger SQL functions, so the k6 load
// test in load-test/ has a real endpoint to hammer, the same way a real
// app's API route would call into Postgres. This is intentionally tiny:
// no framework, just Node's built-in http module, because the point of
// this file is to be an honest stand-in for "your API route that calls
// the deduct function," not a demo of a web framework.
//
// Endpoints:
//   POST /deduct/naive      { amount_cents } -> calls naive_deduct(...)
//   POST /deduct/hardened   { amount_cents } -> calls hardened_deduct(...)
//   POST /reset              resets the demo account to $100.00
//   GET  /balance             returns the current demo account balance
//
// Run with: npm run ledger:server  (defaults to http://localhost:8787)

import http from 'node:http';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const PORT = Number(process.env.LEDGER_SERVER_PORT || 8787);
const CONNECTION_STRING =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

const pool = new Pool({ connectionString: CONNECTION_STRING });

function readSql(filename) {
  return readFileSync(join(__dirname, 'sql', filename), 'utf8');
}

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(readSql('00_schema.sql'));
    await client.query(readSql('01_naive_deduct.sql'));
    await client.query(readSql('02_hardened_deduct.sql'));
  } finally {
    client.release();
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function handleDeduct(fnName, req, res) {
  const body = await readBody(req);
  const amountCents = Number(body.amount_cents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    sendJson(res, 400, { error: 'amount_cents must be a positive number' });
    return;
  }
  try {
    const { rows } = await pool.query(`select * from ${fnName}($1, $2, $3)`, [
      ACCOUNT_ID,
      amountCents,
      `load-test-${fnName}`,
    ]);
    const row = rows[0];
    sendJson(res, row.ok ? 200 : 409, {
      ok: row.ok,
      new_balance_cents: row.new_balance_cents === null ? null : Number(row.new_balance_cents),
      message: row.message,
    });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
}

async function handleReset(res) {
  const client = await pool.connect();
  try {
    await client.query(readSql('03_reset.sql'));
    sendJson(res, 200, { ok: true });
  } finally {
    client.release();
  }
}

async function handleBalance(res) {
  const { rows } = await pool.query('select balance_cents from accounts where id = $1', [ACCOUNT_ID]);
  sendJson(res, 200, { balance_cents: Number(rows[0].balance_cents) });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/deduct/naive') {
      return await handleDeduct('naive_deduct', req, res);
    }
    if (req.method === 'POST' && req.url === '/deduct/hardened') {
      return await handleDeduct('hardened_deduct', req, res);
    }
    if (req.method === 'POST' && req.url === '/reset') {
      return await handleReset(res);
    }
    if (req.method === 'GET' && req.url === '/balance') {
      return await handleBalance(res);
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

ensureSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Ledger demo server listening on http://localhost:${PORT}`);
      console.log('Endpoints: POST /deduct/naive, POST /deduct/hardened, POST /reset, GET /balance');
    });
  })
  .catch((err) => {
    console.error('Failed to initialize schema:', err);
    process.exit(1);
  });
