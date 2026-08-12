import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../lib/retry.js';
import { ApiError, RateLimitError, NetworkError } from '../lib/errors.js';

test('withRetry: returns on first success', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: does not retry non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new ApiError(422, 'bad'); }),
    /HTTP 422/
  );
  assert.equal(calls, 1);
});

test('withRetry: retries on 5xx then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 2) throw new ApiError(503, 'boom');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry: gives up after N tries on rate limit', async () => {
  let calls = 0;
  const slept = [];
  await assert.rejects(
    withRetry(async () => { calls++; throw new RateLimitError('slow down'); },
      { tries: 2, sleep: async ms => { slept.push(ms); } }),
    /HTTP 429/
  );
  assert.equal(calls, 2);
});

// ---- injectable sleep (the pipeline passes its port's clock) ----

test('withRetry: rate-limit backoff grows exponentially', async () => {
  const slept = [];
  await assert.rejects(
    withRetry(async () => { throw new RateLimitError('slow'); },
      { tries: 4, sleep: async ms => { slept.push(ms); } }),
    /HTTP 429/
  );
  assert.deepEqual(slept, [2000, 5000, 12500, 31250]);
});

test('withRetry: 5xx backoff is a flat 3s', async () => {
  const slept = [];
  await assert.rejects(
    withRetry(async () => { throw new ApiError(502, 'gateway'); },
      { tries: 3, sleep: async ms => { slept.push(ms); } }),
    /HTTP 502/
  );
  assert.deepEqual(slept, [3000, 3000, 3000]);
});

test('withRetry: never sleeps for a non-retryable error', async () => {
  const slept = [];
  await assert.rejects(
    withRetry(async () => { throw new ApiError(400, 'bad'); },
      { sleep: async ms => { slept.push(ms); } }),
    /HTTP 400/
  );
  assert.deepEqual(slept, []);
});

test('withRetry: the injected sleep is awaited between attempts', async () => {
  const order = [];
  let calls = 0;
  const result = await withRetry(
    async () => { order.push(`try${++calls}`); if (calls < 2) throw new ApiError(500, 'x'); return 'ok'; },
    { sleep: async () => { order.push('sleep'); } }
  );
  assert.equal(result, 'ok');
  assert.deepEqual(order, ['try1', 'sleep', 'try2']);
});

// ---- NetworkError: a transport blip must not abort a run mid-pipeline ----
// Observed live 2026-07-11: `step_failed:uploadPhoto[2] {"err":"Failed to fetch"}` killed a
// run that had already uploaded two of three photos. It was a plain Error, so withRetry
// classified it non-retryable and rethrew on the first attempt.

test('withRetry: retries a NetworkError, then succeeds', async () => {
  let calls = 0;
  const slept = [];
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new NetworkError('Failed to fetch');
    return 'uploaded';
  }, { sleep: async ms => slept.push(ms) });

  assert.equal(result, 'uploaded');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [1500, 3000], 'backoff grows between attempts');
});

test('withRetry: gives up on a NetworkError after the attempt budget', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new NetworkError('Failed to fetch'); }, { tries: 3, sleep: async () => {} }),
    NetworkError
  );
  assert.equal(calls, 3);
});

test('withRetry: "no Vinted tab open" is NOT retried — the user must act first', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('No Vinted tab open on www.vinted.de.'); }, { sleep: async () => {} }),
    /No Vinted tab open/
  );
  assert.equal(calls, 1, 'retrying cannot conjure a tab');
});
