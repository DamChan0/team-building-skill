import test from 'node:test';
import assert from 'node:assert/strict';
import { resultFrom } from '../src/main.mjs';

test('uses the last fenced worker result and normalizes scalar lists', () => {
  const result = resultFrom('ignore\n```json\n{"status":"failed"}\n```\n```json\n{"status":"succeeded","summary":"done","files_changed":"a.js","verification":["node --test"]}\n```');
  assert.deepEqual(result, { status: 'succeeded', summary: 'done', files_changed: ['a.js'], files_deleted: [], verification: 'node --test', blockers: [], approval_requests: [], branch: '', commit: '' });
});

test('rejects invalid worker result payloads', () => {
  assert.equal(resultFrom('{"status":"pending"}'), null);
});
