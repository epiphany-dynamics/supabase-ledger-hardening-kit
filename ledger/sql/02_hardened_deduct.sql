-- HARDENED deduction function.
--
-- Same shape as naive_deduct: read balance, check funds, write new balance,
-- record a ledger entry. The only structural change is `for update` on the
-- SELECT, which is the fix.
--
-- Why `SELECT ... FOR UPDATE` and not `SERIALIZABLE`:
--
-- Postgres offers two idiomatic ways to make this safe:
--
--   1. SELECT ... FOR UPDATE at READ COMMITTED (this file). The SELECT
--      takes a row-level exclusive lock on the account row. A second
--      concurrent transaction hitting the same row blocks at its own
--      SELECT ... FOR UPDATE until the first transaction commits or rolls
--      back, at which point it re-reads the row and sees the up-to-date
--      balance. The check-then-act sequence becomes atomic per row because
--      no other writer can be "in between" the read and the write for that
--      specific account. This scales well: unrelated accounts never
--      contend with each other, only concurrent writers to the *same*
--      account serialize, which is exactly the contention you want.
--
--   2. SERIALIZABLE isolation on the whole transaction, with the app layer
--      catching serialization_failure (SQLSTATE 40001) and retrying. This
--      also works and is sometimes the better choice when a single logical
--      operation touches multiple tables/rows that all need to be
--      consistent with each other. The tradeoff is that Postgres detects
--      the conflict *after the fact* via predicate locking and aborts one
--      transaction, so the app must implement a retry loop, and under
--      heavy contention on a single hot row you pay for repeated wasted
--      work (transaction runs, then gets rolled back, then reruns).
--
-- For a single-row balance deduction, FOR UPDATE is the more idiomatic and
-- efficient choice: the lock scope matches the actual contention (one
-- account row), there's no wasted transaction work, and there's no retry
-- loop to get wrong in the application. SERIALIZABLE earns its cost when
-- the invariant spans multiple rows/tables in a way row locks can't express
-- cleanly (e.g. a transfer between two different tables' worth of
-- invariants, or an invariant computed from an aggregate over many rows).
create or replace function hardened_deduct(
  p_account_id uuid,
  p_amount_cents bigint,
  p_reason text default 'hardened_deduct'
) returns table (ok boolean, new_balance_cents bigint, message text)
language plpgsql
as $$
declare
  v_balance bigint;
begin
  -- 0. Validate input. This guards against a bad caller (negative or zero
  --    amount), which is a separate concern from the concurrency fix below.
  --    A negative amount here would otherwise silently function as an
  --    uncontrolled credit.
  if p_amount_cents is null or p_amount_cents <= 0 then
    return query select false, null::bigint, 'amount_cents must be a positive integer';
    return;
  end if;

  -- 1. Read the current balance AND lock the row. Any other transaction
  --    trying to SELECT ... FOR UPDATE (or UPDATE) this same row now blocks
  --    here until this transaction commits or rolls back.
  select balance_cents into v_balance
  from accounts
  where id = p_account_id
  for update;

  if v_balance is null then
    return query select false, null::bigint, 'account not found';
    return;
  end if;

  -- 2. Check sufficient funds. Because we hold the row lock, no other
  --    transaction can have changed this balance since step 1, and none
  --    can change it until we're done. The check and the act below are now
  --    effectively one atomic unit for this row.
  if v_balance < p_amount_cents then
    return query select false, v_balance, 'insufficient funds';
    return;
  end if;

  -- Same artificial delay as the naive version, to prove the fix holds up
  -- even when the race window is wide open. Removing this changes nothing
  -- about correctness, only how easy the race is to observe with the naive
  -- version, which is why the test harness always exercises both.
  perform pg_sleep(0.05);

  -- 3. Write the new balance. Still safe even without the lock at this
  --    exact line, because no concurrent writer could have gotten past its
  --    own step 1 while we were holding the lock.
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

-- Row lock scope note: `for update` here locks exactly one row (the account
-- being deducted), identified by the primary key in the WHERE clause. It
-- does not escalate to a table lock, and it does not block reads that don't
-- also request a row lock (plain SELECTs against this table are unaffected
-- thanks to MVCC). Only other FOR UPDATE / FOR SHARE / UPDATE / DELETE
-- statements against this same row contend.
