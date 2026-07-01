-- NAIVE / BROKEN deduction function.
--
-- This is the pattern you find in the wild constantly: it reads like
-- correct code, it passes every manual test, and it passes any test suite
-- that only ever issues one request at a time. It is not safe under
-- concurrency.
--
-- The bug: between the SELECT and the UPDATE, Postgres has not taken any
-- lock on the row. Two concurrent transactions can both run the SELECT,
-- both see the same (sufficient) balance, both decide the deduction is
-- allowed, and both commit an UPDATE. The check-then-act sequence is not
-- atomic, so the "sufficient funds" invariant is only ever enforced against
-- a snapshot that's already stale by the time the write happens.
--
-- Under Postgres's default READ COMMITTED isolation level this reliably
-- produces an incorrect balance despite the `balance_cents >= 0` CHECK
-- constraint on the table: the CHECK only rejects a *single* UPDATE that
-- would go negative; it cannot see that another concurrent UPDATE already
-- spent the balance the current transaction thinks is still there. Because
-- this function computes its UPDATE from the balance it already holds in
-- `v_balance` rather than re-reading at write time, two concurrent callers
-- both going from (e.g.) 100 -> 40 produce a *lost update*: both report
-- success, both "spent" $60, but the balance only reflects one of those
-- deductions, so the account is drained twice (here, $120 total) while the
-- stored balance never actually goes negative and the CHECK never fires.
-- (A variant of this function that re-reads the balance at write time
-- instead of reusing `v_balance` can drive the balance genuinely negative
-- instead; both are real, common shapes of this same underlying race.)
create or replace function naive_deduct(
  p_account_id uuid,
  p_amount_cents bigint,
  p_reason text default 'naive_deduct'
) returns table (ok boolean, new_balance_cents bigint, message text)
language plpgsql
as $$
declare
  v_balance bigint;
begin
  -- 0. Validate input independent of the concurrency bug this function
  --    exists to demonstrate. Without this, any RPC/SQL caller could pass
  --    a negative or zero amount and turn a "deduction" function into an
  --    uncontrolled credit (a negative deduction increases the balance).
  --    This check is orthogonal to the race condition below: it protects
  --    against a bad caller, not against a concurrent caller.
  if p_amount_cents is null or p_amount_cents <= 0 then
    return query select false, null::bigint, 'amount_cents must be a positive integer';
    return;
  end if;

  -- 1. Read the current balance. No lock is taken here.
  select balance_cents into v_balance
  from accounts
  where id = p_account_id;

  if v_balance is null then
    return query select false, null::bigint, 'account not found';
    return;
  end if;

  -- 2. Check sufficient funds against the value we just read.
  --    Another concurrent call can read the exact same v_balance right now,
  --    before either of us has written anything back.
  if v_balance < p_amount_cents then
    return query select false, v_balance, 'insufficient funds';
    return;
  end if;

  -- Simulate realistic request latency (network hop, app-server logic,
  -- payment provider round trip, etc.) so the race window is wide enough
  -- to hit deterministically in a demo. Production races happen without
  -- this, just less predictably.
  perform pg_sleep(0.05);

  -- 3. Write the new balance based on the value read in step 1, not on
  --    whatever the balance actually is right now.
  update accounts
  set balance_cents = v_balance - p_amount_cents,
      updated_at = now()
  where id = p_account_id
  returning balance_cents into v_balance;

  insert into ledger_entries (account_id, amount_cents, reason)
  values (p_account_id, -p_amount_cents, p_reason);

  return query select true, v_balance, 'ok';
end;
$$;
