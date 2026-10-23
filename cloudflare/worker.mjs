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
    return { status: 'invalid', itemCount: null, ageMs: null };
  }
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    return { status: 'invalid', itemCount: null, ageMs: null };
  }
  if (!Array.isArray(feed.items)) {
    return { status: 'invalid', itemCount: null, ageMs: null };
  }
  const successMs = safeTimestamp(feed.lastSuccessfulAt);
  if (feed.status !== 'ok' || successMs === null) {
    return { status: typeof feed.status === 'string' ? feed.status : 'invalid', itemCount: feed.items.length, ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - successMs);
  return { status: ageMs > freshnessMs ? 'stale' : 'ok', itemCount: feed.items.length, ageMs };
}

function validateEnvironment(env) {
  if (!env || typeof env.GITHUB_TOKEN !== 'string' || env.GITHUB_TOKEN.length < 20) {
    throw new Error('configuration');
  }
  if (env.GITHUB_REPOSITORY !== 'RonnsenDD/warnmeldungen-osl-data') {
    throw new Error('configuration');
  }
  if (env.GITHUB_WORKFLOW !== 'update-warnings.yml' || env.GITHUB_REF !== 'main') {
    throw new Error('configuration');
  }
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

async function hasActiveRun(env, fetcher) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/runs`;
  for (const status of ['in_progress', 'queued']) {
    const response = await githubRequest(`${base}?status=${status}&per_page=1`, env.GITHUB_TOKEN, { method: 'GET' }, fetcher);
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

  const freshness = await logFeedFreshness(env, fetcher, nowMs, freshnessMs, log);
  if (freshness.some(item => item.status === 'stale' || item.status === 'unreachable' || item.status === 'invalid' || item.status === 'error')) {
    log.error(JSON.stringify({ event: 'monitor_threshold_exceeded', thresholdMinutes: freshnessMs / 60000 }));
  }

  if (await hasActiveRun(env, fetcher)) {
    log.log(JSON.stringify({ event: 'dispatch_skipped', reason: 'workflow_active', at: nowDate.toISOString() }));
    return { dispatched: false, reason: 'workflow_active', freshness };
  }

  const dispatchUrl = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  const response = await githubRequest(dispatchUrl, env.GITHUB_TOKEN, {
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
