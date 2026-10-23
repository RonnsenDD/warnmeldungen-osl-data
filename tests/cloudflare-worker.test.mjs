import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduled } from '../cloudflare/worker.mjs';

const env = {
  GITHUB_TOKEN: 'test-token-value-long-enough-for-validation',
  GITHUB_REPOSITORY: 'RonnsenDD/warnmeldungen-osl-data',
  GITHUB_WORKFLOW: 'update-warnings.yml',
  GITHUB_REF: 'main',
  FRESHNESS_MINUTES: '15',
};
const fresh = {
  status: 'ok',
  lastAttemptAt: '2026-10-23T08:00:00.000Z',
  lastSuccessfulAt: '2026-10-23T08:00:02.000Z',
  items: [],
};

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    json: async () => typeof body === 'string' ? JSON.parse(body) : body,
  };
}

test('dispatches existing workflow after health checks; no warning payload is published by Worker', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('raw.githubusercontent.com')) return response(200, fresh);
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [] });
    if (url.includes('?status=queued')) return response(200, { workflow_runs: [] });
    if (url.endsWith('/dispatches')) return response(204, '');
    throw new Error('unexpected request');
  };
  const logs = [];
  const result = await runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log: x => logs.push(x), error: x => logs.push(x) } });
  assert.equal(result.dispatched, true);
  assert.equal(calls.filter(x => x.url.endsWith('/dispatches')).length, 1);
  const dispatch = calls.find(x => x.url.endsWith('/dispatches'));
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: 'main' });
  assert.equal(logs.some(x => x.includes('items')), false);
});

test('does not dispatch when a GitHub Actions run is queued or active', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('raw.githubusercontent.com')) return response(200, fresh);
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [{ id: 4 }] });
    throw new Error('must not query queued or dispatch');
  };
  const result = await runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log() {}, error() {} } });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'workflow_active');
  assert.equal(calls.some(url => url.endsWith('/dispatches')), false);
});

test('records stale feed state but still requests a refresh; never treats error as empty success', async () => {
  const stale = { ...fresh, lastSuccessfulAt: '2026-10-23T07:40:00.000Z', items: [{ id: 'fixture' }] };
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('warnungen.json')) return response(200, stale);
    if (url.includes('hochwasser.json')) return response(200, { ...fresh, status: 'error', lastSuccessfulAt: null, items: [] });
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [] });
    if (url.includes('?status=queued')) return response(200, { workflow_runs: [] });
    if (url.endsWith('/dispatches')) return response(204, '');
    throw new Error('unexpected request');
  };
  const logs = [];
  const result = await runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log: x => logs.push(x), error: x => logs.push(x) } });
  assert.equal(result.dispatched, true);
  assert.equal(result.freshness[0].status, 'stale');
  assert.equal(result.freshness[1].status, 'error');
  assert(logs.some(x => x.includes('monitor_threshold_exceeded')));
});

test('sanitizes GitHub errors and does not expose a secret or response body', async () => {
  const fetcher = async url => {
    if (url.includes('raw.githubusercontent.com')) return response(200, fresh);
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [] });
    if (url.includes('?status=queued')) return response(200, { workflow_runs: [] });
    if (url.endsWith('/dispatches')) return response(403, 'secret-token-denied');
    throw new Error('unexpected request');
  };
  const logs = [];
  await assert.rejects(runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log: x => logs.push(x), error: x => logs.push(x) } }), /dispatch_failed/);
  assert(!logs.join('\n').includes('secret-token-denied'));
  assert(!logs.join('\n').includes(env.GITHUB_TOKEN));
});

test('rejects wrong repository and workflow configuration', async () => {
  await assert.rejects(runScheduled({ env: { ...env, GITHUB_REPOSITORY: 'other/repo' } }), /configuration/);
});
