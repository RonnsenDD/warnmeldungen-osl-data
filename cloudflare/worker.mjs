const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;
const API_VERSION = '2022-11-28';
const USER_AGENT = 'warnmeldungen-osl-data-scheduler';

function safeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function parseFeedSummary(text, nowMs, freshnessMs) {
  let feed;
  try {
    feed = JSON.parse(text);
  } catch {
    return { status: 'invalid', itemCount: null, ageMs: null, lastAttemptAt: null, lastSuccessfulAt: null, publishedAt: null };
  }
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    return { status: 'invalid', itemCount: null, ageMs: null, lastAttemptAt: null, lastSuccessfulAt: null, publishedAt: null };
  }
  if (!Array.isArray(feed.items)) {
    return { status: 'invalid', itemCount: null, ageMs: null, lastAttemptAt: null, lastSuccessfulAt: null, publishedAt: null };
  }
  const successMs = safeTimestamp(feed.lastSuccessfulAt);
  const attemptMs = safeTimestamp(feed.lastAttemptAt);
  const publishedMs = safeTimestamp(feed.fetchedAt);
  const timestamps = {
    lastAttemptAt: attemptMs === null ? null : new Date(attemptMs).toISOString(),
    lastSuccessfulAt: successMs === null ? null : new Date(successMs).toISOString(),
    publishedAt: publishedMs === null ? null : new Date(publishedMs).toISOString(),
  };
  if (feed.status !== 'ok' || successMs === null) {
    return { status: typeof feed.status === 'string' ? feed.status : 'invalid', itemCount: feed.items.length, ageMs: null, ...timestamps };
  }
  const ageMs = Math.max(0, nowMs - successMs);
  return { status: ageMs > freshnessMs ? 'stale' : 'ok', itemCount: feed.items.length, ageMs, ...timestamps };
}

function validateEnvironment(env) {
  if (!env || !/^\d+$/.test(String(env.GITHUB_APP_ID || '')) ||
      !/^\d+$/.test(String(env.GITHUB_INSTALLATION_ID || '')) ||
      typeof env.GITHUB_APP_PRIVATE_KEY !== 'string' ||
      !env.GITHUB_APP_PRIVATE_KEY.includes('PRIVATE KEY')) {
    throw new Error('configuration');
  }
  if (env.GITHUB_REPOSITORY !== 'RonnsenDD/warnmeldungen-osl-data') {
    throw new Error('configuration');
  }
  if (env.GITHUB_WORKFLOW !== 'update-warnings.yml' || env.GITHUB_REF !== 'main') {
    throw new Error('configuration');
  }
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  for (let rest = length; rest > 0; rest >>>= 8) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derElement(tag, content) {
  return concatBytes(Uint8Array.of(tag), derLength(content.length), content);
}

function privateKeyDer(pem) {
  const match = pem.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/);
  if (!match || match[1] !== match[3]) throw new Error('configuration');
  const binary = atob(match[2].replace(/\s/g, ''));
  const raw = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (!match[1]) return raw;
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  return derElement(0x30, concatBytes(version, algorithm, derElement(0x04, raw)));
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function createInstallationToken(env, fetcher, nowMs) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyDer(env.GITHUB_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    iat: issuedAt,
    exp: issuedAt + 8 * 60,
    iss: String(env.GITHUB_APP_ID),
  })));
  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsigned),
  ));
  const jwt = `${unsigned}.${base64Url(signature)}`;
  const response = await fetcher(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permissions: { actions: 'write' } }),
      signal: AbortSignal.timeout(12000),
    },
  );
  if (response.status !== 201) throw new Error('github_app_auth');
  const body = await response.json();
  if (typeof body?.token !== 'string' || body.token.length < 20) throw new Error('github_app_auth');
  return body.token;
}

async function githubRequest(url, token, init, fetcher) {
  const response = await fetcher(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  return response;
}

async function hasActiveRun(env, token, fetcher) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/runs`;
  for (const status of ['in_progress', 'queued']) {
    const response = await githubRequest(`${base}?status=${status}&per_page=1`, token, { method: 'GET' }, fetcher);
    if (!response.ok) throw new Error('github_api');
    const body = await response.json();
    if (!body || !Array.isArray(body.workflow_runs)) throw new Error('github_response');
    if (body.workflow_runs.length > 0) return true;
  }
  return false;
}

async function logFeedFreshness(env, fetcher, nowMs, freshnessMs, log) {
  const results = [];
  for (const file of ['warnungen.json', 'hochwasser.json']) {
    const url = `https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY}/main/${file}?t=${nowMs}`;
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        results.push({ source: file, status: 'unreachable', itemCount: null, ageMs: null });
        continue;
      }
      const summary = parseFeedSummary(await response.text(), nowMs, freshnessMs);
      results.push({ source: file, ...summary });
    } catch {
      results.push({ source: file, status: 'unreachable', itemCount: null, ageMs: null });
    }
  }
  for (const result of results) {
    const minutes = result.ageMs === null ? null : Math.floor(result.ageMs / 60000);
    const fields = {
      event: 'feed_freshness',
      source: result.source,
      status: result.status,
      itemCount: result.itemCount,
      ageMinutes: minutes,
      lastAttemptAt: result.lastAttemptAt,
      lastSuccessfulAt: result.lastSuccessfulAt,
      publishedAt: result.publishedAt,
    };
    if (result.status === 'stale' || result.status === 'unreachable' || result.status === 'invalid' || result.status === 'error') {
      log.error(JSON.stringify(fields));
    } else {
      log.log(JSON.stringify(fields));
    }
  }
  return results;
}

export async function runScheduled({ env, fetcher = fetch, now = () => new Date(), log = console } = {}) {
  validateEnvironment(env);
  const nowDate = now();
  const nowMs = nowDate instanceof Date ? nowDate.getTime() : Date.parse(nowDate);
  if (!Number.isFinite(nowMs)) throw new Error('clock');
  const freshnessMs = Number(env.FRESHNESS_MINUTES || 15) * 60 * 1000;
  if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) throw new Error('configuration');

  log.log(JSON.stringify({ event: 'scheduled_run', scheduledAt: nowDate.toISOString() }));
  const freshness = await logFeedFreshness(env, fetcher, nowMs, freshnessMs, log);
  if (freshness.some(item => item.status === 'stale' || item.status === 'unreachable' || item.status === 'invalid' || item.status === 'error')) {
    log.error(JSON.stringify({ event: 'monitor_threshold_exceeded', thresholdMinutes: freshnessMs / 60000 }));
  }

  const token = await createInstallationToken(env, fetcher, nowMs);
  if (await hasActiveRun(env, token, fetcher)) {
    log.log(JSON.stringify({ event: 'dispatch_skipped', reason: 'workflow_active', at: nowDate.toISOString() }));
    return { dispatched: false, reason: 'workflow_active', freshness };
  }

  const dispatchUrl = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  const response = await githubRequest(dispatchUrl, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF }),
  }, fetcher);
  if (response.status !== 204) {
    log.error(JSON.stringify({ event: 'dispatch_failed', status: response.status }));
    throw new Error('dispatch_failed');
  }

  log.log(JSON.stringify({ event: 'workflow_dispatched', at: nowDate.toISOString(), ref: env.GITHUB_REF }));
  return { dispatched: true, freshness };
}

export function createWorker() {
  return {
    async scheduled(controller, env) {
      try {
        return await runScheduled({
          env,
          now: () => new Date(controller.scheduledTime),
        });
      } catch (error) {
        const kind = error instanceof Error ? error.message : 'unknown';
        console.error(JSON.stringify({ event: 'scheduled_run_failed', kind }));
        throw error;
      }
    },
    async fetch() {
      return new Response('Not Found', { status: 404 });
    },
  };
}

export default createWorker();
