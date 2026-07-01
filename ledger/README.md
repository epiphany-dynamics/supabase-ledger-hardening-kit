# Concurrency-Safe Ledger Pattern

This is the centerpiece of the kit: a demonstration of the single most
common way balance/credit systems on Postgres go wrong in production, the
fix, and a runnable test that proves the difference.

## The bug in one sentence

A function that reads a balance, checks if it's sufficient, then writes a
new balance is not atomic just because it lives in one SQL function. Two
concurrent calls can both read the same starting balance before either one
writes anything back.

## Files

```
sql/
  00_schema.sql          accounts + ledger_entries tables, seeds a demo account
  01_naive_deduct.sql     the broken pattern
  02_hardened_deduct.sql  the fix: SELECT ... FOR UPDATE
  03_reset.sql            resets the demo account between test runs
test/
  concurrency-demo.mjs    fires real concurrent requests at both functions
                          and prints the resulting balances
  pgtap_invariant.sql     optional pgTAP checks for single-request contract
                          (does not by itself prove concurrency safety)
```

## The naive version

```sql
select balance_cents into v_balance from accounts where id = p_account_id;

if v_balance < p_amount_cents then
  return query select false, v_balance, 'insufficient funds';
  return;
end if;

update accounts set balance_cents = v_balance - p_amount_cents
where id = p_account_id;
```

This reads correctly. It passes code review. It passes a manual test where
you call it once and check the result. It will pass almost any test suite,
because almost no test suite issues two requests against the same row at
the same instant.

Under Postgres's default `READ COMMITTED` isolation level, nothing here
blocks a second transaction from running the same `SELECT` before the first
transaction's `UPDATE` commits. If an account has $100 and two requests each
try to deduct $60:

1. Request A reads balance = $100.
2. Request B reads balance = $100 (A has not written yet).
3. Request A checks `$100 >= $60`, passes, writes balance = `v_balance - 60`
   using the $100 it read in step 1, committing balance = $40.
4. Request B checks `$100 >= $60`, passes (it's still holding the $100 it
   read in step 2, not the $40 A already committed), and writes balance =
   `v_balance - 60` using its own stale $100, also committing balance =
   $40.

The exact symptom this produces depends on whether the write recomputes
from the value each transaction is holding (a **lost update**: this repo's
`naive_deduct` does exactly this, so both transactions "win," both report
success, and the balance ends up at $40 instead of the correct -$20, which
means $120 in deductions were recorded as successful against a $100
balance while the balance column only reflects one of them) or from a fresh
re-read at write time (which can instead drive the balance genuinely
negative). Either failure mode is possible depending on exactly how the
write statement is phrased; the demo in this repo reliably reproduces the
lost-update variant. Both are invisible to the
`balance_cents >= 0` CHECK constraint on the table, because neither
individual UPDATE, taken by itself, ever tries to write a value that
violates the constraint. The invariant violation is emergent across two
transactions, not visible in either one.

## The hardened version

```sql
select balance_cents into v_balance from accounts where id = p_account_id
for update;

if v_balance < p_amount_cents then
  return query select false, v_balance, 'insufficient funds';
  return;
end if;

update accounts set balance_cents = v_balance - p_amount_cents
where id = p_account_id;
```

One clause changed: `for update`. This takes a row-level lock on the
account being read. A second transaction that also tries to
`SELECT ... FOR UPDATE` the same row blocks until the first transaction
commits or rolls back. When it finally proceeds, it re-reads the
now-current balance, sees the deduction that already happened, and
correctly rejects the second request if funds are now insufficient.

The check-then-act sequence becomes atomic per row, without taking a
table-wide lock and without blocking unrelated accounts from being read or
written concurrently.

## Why `FOR UPDATE` instead of `SERIALIZABLE`

Both are valid, idiomatic Postgres tools for this class of problem:

- **`SELECT ... FOR UPDATE`** (used here) takes a pessimistic lock scoped to
  the exact row(s) the transaction touches. For a single-row balance
  deduction, this is the more direct tool: the lock scope matches the
  actual contention, there's no wasted transaction work, and the
  application doesn't need a retry loop.
- **`SERIALIZABLE`** isolation makes Postgres detect conflicting
  transactions after the fact (via predicate locking) and abort one of them
  with a `serialization_failure` (SQLSTATE `40001`), which the application
  must catch and retry. This is the better tool when a single logical
  operation's invariant spans multiple rows or tables in a way that's
  awkward to express as a fixed set of row locks (for example, an invariant
  computed from an aggregate over many rows, or a multi-table transfer).

For "deduct from this one row if there's enough in it," `FOR UPDATE` is the
right-sized tool.

## Running the concurrency demo

Requires a reachable Postgres database (local Postgres, Supabase, or any
Postgres 13+ instance). Set `DATABASE_URL` in `.env` at the repo root, or
export it directly.

```bash
npm install
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
npm run ledger:demo
```

The script:

1. Applies the schema and both function definitions.
2. Resets the demo account to a $100.00 balance.
3. Fires 2 concurrent `naive_deduct($60.00)` calls against the same account
   and prints the results and the final balance.
4. Resets the account back to $100.00.
5. Fires 2 concurrent `hardened_deduct($60.00)` calls and prints the same.
6. Exits non-zero if the hardened version ever fails to hold the invariant.
   (The naive version failing is the expected, demonstrated behavior, not a
   failure of the script.)

### Expected output shape

The naive run typically shows both requests succeeding, and a final balance
that does not equal `$100.00 - (successes * $60.00)`, i.e. a double-spend:
both calls "saw" a balance high enough to permit their own deduction. The
hardened run shows exactly one request succeeding, one correctly rejected
with `insufficient funds`, and a final balance of exactly `$40.00`.

Note that with only 2 concurrent requests and an artificial 50ms delay
inside each function, the race is close to deterministic. In a real
application the race is timing-dependent and may not reproduce on every
run, which is precisely what makes this class of bug so easy to miss in
manual testing and so common in production.

## Adapting this to your schema

The pattern generalizes directly to any "read balance, check sufficiency,
write new value" operation: credit deductions, inventory decrements,
seat/slot reservations, rate-limit counters backed by Postgres, or
marketplace payouts. The two things to carry over are:

1. Do the sufficiency check and the write inside the same transaction, with
   `FOR UPDATE` on the read (or `SERIALIZABLE` if the invariant spans
   multiple rows).
2. Keep a `CHECK` constraint on the balance column as defense in depth. It
   won't catch the concurrency bug by itself, but it will catch bugs in the
   application logic itself (e.g. a wrong sign, a unit mismatch).
