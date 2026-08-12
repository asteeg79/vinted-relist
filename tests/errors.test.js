import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, ApiError, RateLimitError, ValidationError } from '../lib/errors.js';

test('AuthError: name + message', () => {
  const e = new AuthError('nope');
  assert.equal(e.name, 'AuthError');
  assert.equal(e.message, 'nope');
  assert.ok(e instanceof Error);
});

test('ApiError: carries status + body, message includes status', () => {
  const e = new ApiError(404, 'not found');
  assert.equal(e.name, 'ApiError');
  assert.equal(e.status, 404);
  assert.equal(e.body, 'not found');
  assert.match(e.message, /HTTP 404/);
});

test('ApiError: truncates long body in message but keeps full body', () => {
  const long = 'x'.repeat(1000);
  const e = new ApiError(500, long);
  assert.ok(e.message.length < 400);
  assert.equal(e.body.length, 1000);
});

test('ApiError: tolerates non-string body', () => {
  const e = new ApiError(500, { foo: 1 });
  assert.match(e.message, /HTTP 500/);
  assert.deepEqual(e.body, { foo: 1 });
});

test('RateLimitError: is an ApiError with status 429', () => {
  const e = new RateLimitError('slow down');
  assert.ok(e instanceof ApiError);
  assert.equal(e.status, 429);
  assert.equal(e.name, 'RateLimitError');
});

test('ValidationError: name + message', () => {
  const e = new ValidationError('bad input');
  assert.equal(e.name, 'ValidationError');
  assert.equal(e.message, 'bad input');
});
