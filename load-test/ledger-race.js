// k6 load test: fires a burst of concurrent deduction requests against the
// SAME account and asserts that the final balance is exactly what it
// should be, given the number of requests that actually succeeded.
//
// This targets ledger/server.mjs (see ../ledger/README.md), which wraps
// the naive_deduct and hardened_deduct SQL functions in a plain HTTP API.
// Point TARGET_PATH at whichever one you want to stress: this script is
// deliberately endpoint-agnostic so you can run it against either your
// naive or hardened implementation, or against your own app's real
// endpoint once you've adapted the pattern.
//
// Design note: this uses a single VU firing a true concurrent HTTP batch
// (http.batch) rather than k6's multi-VU scenario executor. The point of
// this test is not throughput, it's "N requests land on the same row at
// the same instant, does the balance come out right." http.batch fires all
// requests over separate connections in parallel and blocks until every
// response is back, which gives us a clean, deterministic set of responses
// to sum in the SAME script that made the requests, so the correctness
// assertion doesn't depend on cross-VU metric aggregation timing.
//
// Usage:
//   npm run ledger:server &        # in one terminal
//   k6 run load-test/ledger-race.js                              # tests hardened by default
//   k6 run -e TARGET_PATH=/deduct/naive load-test/ledger-race.js   # tests the naive one
//
// Configurable via -e KEY=value:
//   BASE_URL                default http://localhost:8787
//   TARGET_PATH              default /deduct/hardened
//   CONCURRENT_REQUESTS      default 25   (requests fired in the same batch)
//   AMOUNT_CENTS             default 500  ($5.00 per deduction attempt)
//   STARTING_BALANCE_CENTS   default 10000 ($100.00, must match ledger/sql/03_reset.sql)

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';
const TARGET_PATH = __ENV.TARGET_PATH || '/deduct/hardened';
const CONCURRENT_REQUESTS = Number(__ENV.CONCURRENT_REQUESTS || 25);
const AMOUNT_CENTS = Number(__ENV.AMOUNT_CENTS || 500);
const STARTING_BALANCE_CENTS = Number(__ENV.STARTING_BALANCE_CENTS || 10000);

export const options = {
  scenarios: {
    // A single iteration on a single VU. All the actual concurrency comes
    // from firing CONCURRENT_REQUESTS requests in one http.batch() call
    // below, not from k6 VUs, so this is intentionally not a "ramp up
    // load" style test.
    single_burst: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  // IMPORTANT: k6 does NOT fail the process exit code just because a
  // check() call fails. Failed checks are recorded as metrics, but by
  // default k6 still exits 0. The `checks` threshold below is what turns a
  // failed correctness assertion into a non-zero exit code, which is the
  // whole point of using this as a CI gate. Without this, the naive
  // endpoint's checks would print failures and k6 would still "pass."
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export function setup() {
  const resetRes = http.post(`${BASE_URL}/reset`);
  check(resetRes, { 'reset succeeded': (r) => r.status === 200 });

  const balanceBefore = http.get(`${BASE_URL}/balance`).json('balance_cents');
  if (balanceBefore !== STARTING_BALANCE_CENTS) {
    throw new Error(
      `Account did not reset to expected starting balance. Expected ${STARTING_BALANCE_CENTS}, got ${balanceBefore}. ` +
        'Check that STARTING_BALANCE_CENTS matches ledger/sql/03_reset.sql.',
    );
  }
}

export default function () {
  const requests = Array.from({ length: CONCURRENT_REQUESTS }, () => ({
    method: 'POST',
    url: `${BASE_URL}${TARGET_PATH}`,
    body: JSON.stringify({ amount_cents: AMOUNT_CENTS }),
    params: { headers: { 'Content-Type': 'application/json' } },
  }));

  // Fires all requests concurrently over separate connections and waits
  // for every response. This is the actual "N concurrent requests against
  // the same balance" moment the whole test exists to create.
  const responses = http.batch(requests);

  let successCount = 0;
  let rejectedCount = 0;
  let unexpectedCount = 0;

  responses.forEach((res, i) => {
    if (res.status === 200) {
      successCount += 1;
    } else if (res.status === 409) {
      rejectedCount += 1;
    } else {
      unexpectedCount += 1;
      console.error(`Unexpected response [${i}]: status=${res.status} body=${res.body}`);
    }
  });

  const balanceAfter = http.get(`${BASE_URL}/balance`).json('balance_cents');
  const expectedBalance = STARTING_BALANCE_CENTS - successCount * AMOUNT_CENTS;

  console.log(`\n=== Ledger Race Load Test Result (${TARGET_PATH}) ===`);
  console.log(`Concurrent requests fired: ${CONCURRENT_REQUESTS}`);
  console.log(`Amount per request:        $${(AMOUNT_CENTS / 100).toFixed(2)}`);
  console.log(`Starting balance:          $${(STARTING_BALANCE_CENTS / 100).toFixed(2)}`);
  console.log(`Successful (200):          ${successCount}`);
  console.log(`Rejected, insufficient (409): ${rejectedCount}`);
  console.log(`Unexpected errors:         ${unexpectedCount}`);
  console.log(`Expected final balance:    $${(expectedBalance / 100).toFixed(2)}`);
  console.log(`Actual final balance:      $${(balanceAfter / 100).toFixed(2)}`);

  // This is the assertion that matters. Everything above is diagnostic
  // output; this is the pass/fail line. A failed check() here feeds the
  // `checks` metric, and it's the `thresholds: { checks: ['rate==1.0'] }`
  // block in `options` above that turns that into k6's non-zero process
  // exit code (k6 does NOT fail the exit code on a bare failed check
  // without an explicit threshold). That combination is what makes this
  // usable as a CI gate against regressions in the ledger logic.
  check(
    { balanceAfter, expectedBalance, unexpectedCount },
    {
      'final balance matches successful-deduction count exactly (no double-spend)': (r) =>
        r.balanceAfter === r.expectedBalance,
      'final balance never went negative': (r) => r.balanceAfter >= 0,
      'no unexpected (non-200/409) responses': (r) => r.unexpectedCount === 0,
    },
  );
}
