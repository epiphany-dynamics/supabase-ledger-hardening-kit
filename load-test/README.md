# Load Test: Ledger Race Condition

A [k6](https://k6.io/) script that fires a burst of genuinely concurrent
requests at the ledger's deduction endpoint and asserts the final balance
is exactly correct, not "close enough."

This is a correctness test wearing a load test's clothes. The goal isn't
throughput or latency percentiles, it's proving that under real concurrent
traffic, the balance invariant holds: `final_balance == starting_balance -
(successful_deductions * amount)`, always, exactly.

## How it works

1. `setup()` resets the demo account to a known starting balance ($100.00)
   via `POST /reset` on the ledger demo server.
2. The default function fires `CONCURRENT_REQUESTS` (25 by default) HTTP
   requests to the same deduction endpoint **at the same time**, using
   k6's `http.batch()`, which opens separate connections and sends every
   request before waiting for any response.
3. Once every response is back, it fetches the final balance and checks
   `final_balance === starting_balance - (successCount * amount)`.
4. k6 turns any failed `check()` into a non-zero exit code, so this is
   usable as a CI gate.

## Running it

You need [k6](https://k6.io/docs/get-started/installation/) installed, and
the ledger demo server running against a real Postgres database.

```bash
# Terminal 1: start the demo server (wraps the SQL functions in HTTP)
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
npm run ledger:server

# Terminal 2: run the load test against the HARDENED endpoint (default)
npm run load:test

# Or explicitly target either implementation:
k6 run load-test/ledger-race.js                                # hardened (default)
k6 run -e TARGET_PATH=/deduct/naive load-test/ledger-race.js    # naive (expected to fail)
```

## Expected results

Against `/deduct/hardened`, every run should pass all three checks: the
final balance matches the successful-deduction count exactly, it never goes
negative, and there are no unexpected error responses.

Against `/deduct/naive`, expect the "final balance matches" check to fail
under load. With 25 concurrent requests for $5.00 each against a $100.00
balance, the naive version typically lets more requests succeed than the
balance can actually cover, because many of them read the stale
pre-deduction balance before any of the concurrent writes land. This is the
demonstrated failure, not a bug in the test.

## Tuning

All parameters are configurable via `-e KEY=value`:

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:8787` | Where the ledger demo server is running |
| `TARGET_PATH` | `/deduct/hardened` | Which endpoint to hit |
| `CONCURRENT_REQUESTS` | `25` | How many requests fire in the same batch |
| `AMOUNT_CENTS` | `500` | Deduction amount per request, in cents |
| `STARTING_BALANCE_CENTS` | `10000` | Must match `ledger/sql/03_reset.sql` |

## Adapting this to your own endpoint

Point `BASE_URL` and `TARGET_PATH` at your own app's real deduction/charge
endpoint instead of the bundled demo server, and adjust the request body
shape in `ledger-race.js` to match your API. The assertion logic (final
balance must equal starting balance minus successful deductions, exactly)
carries over unchanged: it's the right test for any endpoint that decrements
a shared balance, regardless of what's behind it.
