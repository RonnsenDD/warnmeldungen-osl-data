import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { runScheduled } from '../cloudflare/worker.mjs';

const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
const privateKeyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs1', format: 'pem' }).toString();
const env = {
  GITHUB_APP_ID: '12345',
  GITHUB_INSTALLATION_ID: '67890',
  GITHUB_APP_PRIVATE_KEY: privateKeyPem,
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

const installationToken = 'ghs_mock_installation_token_for_tests';

function mockGitHub(handler) {
  return async (url, init = {}) => {
    if (url.endsWith('/app/installations/67890/access_tokens')) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { permissions: { actions: 'write' } });
      const jwt = init.headers.Authorization.slice('Bearer '.length);
      assert.equal(jwt.split('.').length, 3);
      const [header, encodedPayload, encodedSignature] = jwt.split('.');
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      assert.equal(payload.iss, env.GITHUB_APP_ID);
      const signature = new Uint8Array(Buffer.from(encodedSignature, 'base64url'));
      assert.equal(await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        keyPair.publicKey,
        signature,
        new TextEncoder().encode(`${header}.${encodedPayload}`),
      ), true);
      return response(201, { token: installationToken, expires_at: '2026-10-23T08:08:00Z' });
    }
    if (url.includes('/actions/workflows/')) {
      assert.equal(init.headers.Authorization, `Bearer ${installationToken}`);
    }
    return handler(url, init);
  };
}

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
  const fetcher = mockGitHub(async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('raw.githubusercontent.com')) return response(200, fresh);
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [] });
    if (url.includes('?status=queued')) return response(200, { workflow_runs: [] });
    if (url.endsWith('/dispatches')) return response(204, '');
    throw new Error('unexpected request');
  });
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
  const fetcher = mockGitHub(async url => {
    calls.push(url);
    if (url.includes('raw.githubusercontent.com')) return response(200, fresh);
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [{ id: 4 }] });
    throw new Error('must not query queued or dispatch');
  });
  const result = await runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log() {}, error() {} } });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'workflow_active');
  assert.equal(calls.some(url => url.endsWith('/dispatches')), false);
});

test('records stale feed state but still requests a refresh; never treats error as empty success', async () => {
  const stale = { ...fresh, lastSuccessfulAt: '2026-10-23T07:40:00.000Z', items: [{ id: 'fixture' }] };
  const calls = [];
  const fetcher = mockGitHub(async url => {
    calls.push(url);
    if (url.includes('warnungen.json')) return response(200, stale);
    if (url.includes('hochwasser.json')) return response(200, { ...fresh, status: 'error', lastSuccessfulAt: null, items: [] });
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [] });
    if (url.includes('?status=queued')) return response(200, { workflow_runs: [] });
    if (url.endsWith('/dispatches')) return response(204, '');
    throw new Error('unexpected request');
  });
  const logs = [];
  const result = await runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log: x => logs.push(x), error: x => logs.push(x) } });
  assert.equal(result.dispatched, true);
  assert.equal(result.freshness[0].status, 'stale');
  assert.equal(result.freshness[1].status, 'error');
  assert(logs.some(x => x.includes('monitor_threshold_exceeded')));
});

test('sanitizes GitHub errors and does not expose a secret or response body', async () => {
  const fetcher = mockGitHub(async url => {
    if (url.includes('raw.githubusercontent.com')) return response(200, fresh);
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [] });
    if (url.includes('?status=queued')) return response(200, { workflow_runs: [] });
    if (url.endsWith('/dispatches')) return response(403, 'secret-token-denied');
    throw new Error('unexpected request');
  });
  const logs = [];
  await assert.rejects(runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log: x => logs.push(x), error: x => logs.push(x) } }), /dispatch_failed/);
  assert(!logs.join('\n').includes('secret-token-denied'));
  assert(!logs.join('\n').includes(env.GITHUB_APP_PRIVATE_KEY));
  assert(!logs.join('\n').includes(installationToken));
});


test('treats unknown and partial feed statuses as not fully fresh', async () => {
  const fetcher = mockGitHub(async url => {
    if (url.includes('warnungen.json')) return response(200, { ...fresh, status: 'partial' });
    if (url.includes('hochwasser.json')) return response(200, fresh);
    if (url.includes('?status=in_progress')) return response(200, { workflow_runs: [] });
    if (url.includes('?status=queued')) return response(200, { workflow_runs: [] });
    if (url.endsWith('/dispatches')) return response(204, '');
    throw new Error('unexpected request');
  });
  const logs = [];
  const result = await runScheduled({ env, fetcher, now: () => new Date('2026-10-23T08:00:05.000Z'), log: { log: x => logs.push(x), error: x => logs.push(x) } });
  assert.equal(result.freshness[0].status, 'partial');
  assert(logs.some(line => line.includes('monitor_threshold_exceeded')));
});

test('rejects wrong repository and workflow configuration', async () => {
  await assert.rejects(runScheduled({ env: { ...env, GITHUB_REPOSITORY: 'other/repo' } }), /configuration/);
});
