# Supabase Ledger Hardening Kit

A small, focused toolkit demonstrating production-grade patterns for hardening
Supabase/Postgres-backed applications that handle money, credits, or any other
balance that must never go negative or get double-spent.

This repo packages up patterns extracted from real hardening work on live
production systems: subscription platforms, in-app credit systems, and
marketplace balance ledgers all fail in the same three ways. This kit shows
each failure class, the fix, and a way to prove the fix actually works.

Generalized from a client engagement. Case study: https://patrickgibbs.dev/work/case/bbq-registry/

## The three failure classes

Almost every "balance went negative" or "user saw someone else's data"
incident on a Supabase/Postgres stack traces back to one of these:

1. **Race-condition double-spends.** Two concurrent requests both read the
   same balance, both pass an "is there enough money/credits?" check, and
   both write a deduction. No single request did anything wrong in
   isolation; the bug only exists in the interleaving. This is invisible in
   manual testing and in almost any staging environment, because it requires
   genuine concurrency to trigger. It shows up in production the first time
   two requests for the same user land within the same few milliseconds
   (double-clicks, retried webhooks, two devices, a flaky client that
   resubmits).

2. **Row-Level-Security misconfiguration.** Supabase makes RLS easy to turn
   on and dangerously easy to get subtly wrong: a policy that checks the
   wrong column, a `USING` clause without a matching `WITH CHECK`, a policy
   that's technically present but evaluates to `true` for everyone, or a
   table where RLS was simply never enabled after being created via the
   dashboard. These bugs don't show up in the happy-path demo: they show up
   when someone points a REST client at the anon key and starts poking
   tables that were never meant to be reachable that way.

3. **Untested behavior under real concurrent load.** Most test suites run
   requests one at a time. Most production incidents involve dozens to
   thousands of requests landing close together. A codebase can have 100%
   test coverage on business logic and still have never once been exercised
   with two overlapping writes to the same row.

Each of the three folders in this repo targets one of these directly.

## What's in here

```
ledger/               Concurrency-safe balance/credit ledger pattern
                       (the centerpiece: naive vs. hardened, with tests
                       that prove the difference under real concurrency)
rls-test-harness/      A runnable RLS audit tool for any Supabase project
load-test/             k6 script that hammers the ledger endpoint concurrently
                       and asserts the final balance is arithmetically correct
```

### `ledger/`: concurrency-safe balance operations

The centerpiece of this kit. Contains:

- A **naive** balance-deduction function that looks correct in isolation
  (read balance, check sufficient funds, write new balance) but is not
  safe under concurrency.
- A **hardened** version using `SELECT ... FOR UPDATE` row-level locking so
  concurrent requests against the same account are serialized at the row,
  not the table.
- A test harness that fires concurrent requests at both versions and proves,
  with real numbers, that the naive version produces a negative or
  inconsistent balance while the hardened version never does.

See `ledger/README.md` for the full writeup, the SQL, and how to run the
tests.

### `rls-test-harness/`: RLS misconfiguration probe

A Node script that takes a Supabase project's URL plus anon and (optionally)
service-role keys and runs a checklist of common RLS misconfiguration probes
against tables you point it at: anonymous read access, cross-user
read/write, missing `WITH CHECK` clauses, and RLS-disabled-entirely checks.
Built to be run against any real Supabase project, not just this repo's demo
schema.

See `rls-test-harness/README.md` for setup and the full probe list.

### `load-test/`: concurrency load test

A k6 script that sends N concurrent requests at a ledger deduction endpoint
for the same account and asserts, after the dust settles, that the final
balance equals `starting_balance - (successful_deductions * amount)` exactly,
not "approximately," exactly. Any drift means a race condition slipped
through.

See `load-test/README.md` for how to point it at your own endpoint.

## Why this matters

None of these patterns are exotic. `SELECT ... FOR UPDATE` has existed in
Postgres for decades, and Supabase's RLS model is well documented. The
failure mode isn't "nobody knows the right pattern": it's that the naive
version and the hardened version produce **identical results in every
manual test and every single-request integration test**. The bug is only
observable under concurrency, and RLS gaps are only observable when you
deliberately try to break them from outside the app's own client code. That
means these bugs pass code review, pass QA, and pass a demo to the client,
and then show up in production as a support ticket about a balance that
doesn't add up, or a data leak nobody can explain.

This kit exists so that "does our ledger survive concurrent writes?" and
"does our RLS actually enforce what we think it does?" have a concrete,
runnable answer instead of a hopeful one.

## Requirements

- Node.js 18+
- A Postgres database (local, Supabase-hosted, or any Postgres 13+) for the
  `ledger/` demo
- A Supabase project (any tier, including free) if you want to run
  `rls-test-harness/` against a real project
- [k6](https://k6.io/) if you want to run the load test

## Quick start

```bash
npm install
cp .env.example .env   # fill in your own Postgres / Supabase credentials

# 1. See the race condition and the fix
npm run ledger:demo

# 2. Audit a Supabase project's RLS policies
npm run rls:audit

# 3. Load-test the ledger endpoint
npm run load:test
```

## Tests

There is no automated test suite and no `npm test` script. The proof lives in two runnable pieces, both of which need a reachable Postgres database:

- `npm run ledger:demo` (`ledger/test/concurrency-demo.mjs`) fires concurrent deductions at the naive and hardened functions and prints the resulting balances. The naive run double-spends, the hardened run does not. This is the test that matters.
- `npm run load:test` (k6, see `load-test/`) sends a burst of concurrent requests and asserts the final balance is arithmetically exact.
- `ledger/test/pgtap_invariant.sql` holds optional pgTAP checks for the single-request contract. These do not prove concurrency safety on their own.

Neither of the first two ran while this README was written, because no Postgres was reachable in that environment. The `rls-test-harness/` probes need a live Supabase project and were not run either.

## Known limits

- The RLS probe logic is checked against documented PostgREST and Supabase semantics by review, but has not been smoke-tested end to end against a live project. Run it once against staging and confirm the findings before wiring it into a gate.
- Point `DATABASE_URL` at a scratch database. The demo creates its own `accounts` and `ledger_entries` tables.
- The hardened pattern takes a row lock with `SELECT ... FOR UPDATE`, which serializes writes against the same account. That is the point, but it means a single hot account is a throughput ceiling. `SERIALIZABLE` is the alternative when an invariant spans more than one row.

## License

MIT, see `LICENSE`. Use, fork, and adapt freely.

---

Built and maintained by [Epiphany Dynamics](https://epiphanydynamics.ai), an
AI automation agency. We do this kind of hardening work on live client
systems; this repo is the generic, reusable version of the patterns we keep
reaching for.
