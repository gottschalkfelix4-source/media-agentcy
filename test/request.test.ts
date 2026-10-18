/**
 * Request follow-up: where a request is stuck and what the agent should do about it.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestVerdict, type RequestFacts } from '../src/agent/requestTools.js';

const base: RequestFacts = {
  type: 'movie',
  ageDays: 3,
  requestStatus: 2,
  mediaStatus: 3,
  arr: { monitored: true, complete: false, released: true },
  queue: [],
  library: 'none',
};
const v = (f: Partial<RequestFacts>) => requestVerdict({ ...base, ...f });

test('request system states come first', () => {
  assert.equal(v({ mediaStatus: 5 }).stage, 'available');
  assert.equal(v({ requestStatus: 1, ageDays: 0 }).stage, 'waiting_for_approval');
  assert.equal(v({ requestStatus: 1, ageDays: 0 }).action, undefined);
  assert.equal(v({ requestStatus: 1, ageDays: 2 }).action, 'remind_admin');
  assert.equal(v({ requestStatus: 3 }).stage, 'declined');
  assert.equal(v({ requestStatus: 4 }).action, 'retry_request');
});

test('downloader states', () => {
  assert.equal(v({ arr: null }).stage, 'not_in_downloader');
  assert.equal(v({ arr: null }).action, 'retry_request');
  assert.equal(v({ arr: null, requestStatus: undefined, mediaStatus: undefined }).stage, 'not_requested');
  assert.equal(v({ arr: { monitored: false, complete: false } }).action, 'escalate');
  assert.equal(v({ queue: [{ problems: [] }] }).stage, 'downloading');
  assert.equal(v({ queue: [{ problems: ['No files found are eligible for import'] }] }).action, 'search_again');
  assert.equal(v({ queue: [{ problems: [], health: 'warning' }] }).stage, 'download_problem');
  assert.equal(v({ lastFailure: 'Unpack failed' }).stage, 'download_failed');
  assert.equal(v({ arr: { monitored: true, complete: false, released: false } }).stage, 'not_released');
});

test('downloaded but missing in the library → rescan, present everywhere → available', () => {
  const done = { monitored: true, complete: true };
  assert.equal(v({ arr: done, library: 'none' }).action, 'rescan_library');
  assert.equal(v({ arr: done, library: 'some' }).stage, 'downloaded_not_in_library');
  assert.equal(v({ arr: done, library: 'all' }).stage, 'available');
  assert.equal(v({ arr: done, library: undefined }).stage, 'available');
});

test('nothing found yet: wait on day 0, search again later', () => {
  assert.equal(v({ ageDays: 0 }).stage, 'searching');
  assert.equal(v({ ageDays: 0 }).action, undefined);
  assert.equal(v({ ageDays: 3 }).action, 'search_again');
  assert.match(v({ ageDays: 20 }).hint, /Admin/);
  const series = { type: 'tv' as const, arr: { monitored: true, complete: false, partial: true, continuing: true } };
  assert.equal(v({ ...series, ageDays: 0 }).stage, 'partially_available');
  assert.equal(v({ ...series, ageDays: 5 }).action, 'search_again');
});
