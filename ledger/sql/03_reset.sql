-- Reset the demo account to a known balance so each test run is
-- reproducible. Called by the Node harness before every scenario.
update accounts
set balance_cents = 10000, -- $100.00
    updated_at = now()
where id = '00000000-0000-0000-0000-000000000001';

delete from ledger_entries
where account_id = '00000000-0000-0000-0000-000000000001';
