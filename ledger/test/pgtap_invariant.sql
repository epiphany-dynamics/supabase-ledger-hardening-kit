-- Optional pgTAP test: single-connection invariant checks for both
-- functions. This does NOT exercise concurrency (a single SQL session
-- can't run two overlapping transactions against itself), so it will not
-- catch the race condition on its own -- that's what
-- ledger/test/concurrency-demo.mjs is for. What this file verifies is the
-- basic contract each function must uphold in isolation: correct balance
-- arithmetic, rejection of over-drafts, and (for the hardened version)
-- that FOR UPDATE does not change single-request behavior at all. Keep
-- both: pgTAP for the deterministic single-connection contract, the Node
-- harness for the concurrency proof.
--
-- Requires the pgTAP extension: create extension if not exists pgtap;
-- Run with: pg_prove -d <your_db> ledger/test/pgtap_invariant.sql
-- or: psql -d <your_db> -f ledger/test/pgtap_invariant.sql

begin;
select plan(8);

-- Fresh state
select set_eq(
  $$ select balance_cents from accounts where id = '00000000-0000-0000-0000-000000000001' $$,
  $$ values (10000::bigint) $$,
  'demo account starts at $100.00 (seeded by 00_schema.sql)'
);

-- Naive deduct: a single, non-concurrent call behaves correctly.
select results_eq(
  $$ select ok, new_balance_cents from naive_deduct(
       '00000000-0000-0000-0000-000000000001', 3000, 'pgtap-naive-ok'
     ) $$,
  $$ values (true, 7000::bigint) $$,
  'naive_deduct: single call deducts correctly ($100.00 -> $70.00)'
);

select results_eq(
  $$ select ok, message from naive_deduct(
       '00000000-0000-0000-0000-000000000001', 999999, 'pgtap-naive-overdraft'
     ) $$,
  $$ values (false, 'insufficient funds'::text) $$,
  'naive_deduct: rejects a deduction larger than the balance'
);

select is(
  (select balance_cents from accounts where id = '00000000-0000-0000-0000-000000000001'),
  7000::bigint,
  'naive_deduct: rejected overdraft attempt left balance unchanged'
);

-- Reset for the hardened function's isolated checks.
select set_eq(
  $$ select balance_cents from accounts where id = '00000000-0000-0000-0000-000000000001' $$,
  $$ values (7000::bigint) $$,
  'sanity check before resetting for hardened_deduct tests'
);

update accounts set balance_cents = 10000
where id = '00000000-0000-0000-0000-000000000001';

-- Hardened deduct: same single-call contract as naive_deduct. The lock
-- must not change correct single-request behavior, only concurrent
-- behavior.
select results_eq(
  $$ select ok, new_balance_cents from hardened_deduct(
       '00000000-0000-0000-0000-000000000001', 4000, 'pgtap-hardened-ok'
     ) $$,
  $$ values (true, 6000::bigint) $$,
  'hardened_deduct: single call deducts correctly ($100.00 -> $60.00)'
);

select results_eq(
  $$ select ok, message from hardened_deduct(
       '00000000-0000-0000-0000-000000000001', 999999, 'pgtap-hardened-overdraft'
     ) $$,
  $$ values (false, 'insufficient funds'::text) $$,
  'hardened_deduct: rejects a deduction larger than the balance'
);

select is(
  (select balance_cents from accounts where id = '00000000-0000-0000-0000-000000000001'),
  6000::bigint,
  'hardened_deduct: rejected overdraft attempt left balance unchanged'
);

select * from finish();
rollback;
