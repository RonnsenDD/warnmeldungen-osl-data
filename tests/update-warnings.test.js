const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateFeed } = require('../update-warnings.js');

async function isolated(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osl-feed-test-'));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const source = { file: 'warnungen.json', url: 'https://example.invalid/alerts' };
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, source.file), 'utf8'));

test('Leere erfolgreiche Warnliste erhält Abschlusszeitpunkt', () => isolated(async dir => {
  const times = ['2026-10-23T08:00:00.000Z', '2026-10-23T08:00:02.000Z'];
  const ok = await updateFeed('warnungen', source, {
    directory: dir, now: () => times.shift(),
    fetcher: async () => ({ ok: true, json: async () => [] }),
  });
  assert.equal(ok, true);
  assert.equal(read(dir).status, 'ok');
  assert.deepEqual(read(dir).items, []);
  assert.equal(read(dir).lastAttemptAt, '2026-10-23T08:00:00.000Z');
  assert.equal(read(dir).lastSuccessfulAt, '2026-10-23T08:00:02.000Z');
  assert.equal(read(dir).fetchedAt, read(dir).lastSuccessfulAt);
  assert.equal(fs.readdirSync(dir).length, 1);
}));

test('Fehler erhält letzten Erfolg und Daten, verbirgt sensible Details', () => isolated(async dir => {
  fs.writeFileSync(path.join(dir, source.file), JSON.stringify({
    status: 'ok', items: [{ id: 'old' }], lastSuccessfulAt: '2026-10-23T06:00:00.000Z',
  }));
  const ok = await updateFeed('warnungen', source, {
    directory: dir, now: () => '2026-10-23T08:00:00.000Z',
    fetcher: async () => { throw new Error('TOKEN=secret'); },
  });
  assert.equal(ok, false);
  assert.equal(read(dir).status, 'error');
  assert.deepEqual(read(dir).items, [{ id: 'old' }]);
  assert.equal(read(dir).lastSuccessfulAt, '2026-10-23T06:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(read(dir)), /secret|TOKEN/);
  assert.equal(fs.readdirSync(dir).length, 1);
}));

test('Ungültiges Format erzeugt keine bestätigte Warnfreiheit', () => isolated(async dir => {
  const ok = await updateFeed('warnungen', source, {
    directory: dir, now: () => '2026-10-23T08:00:00.000Z',
    fetcher: async () => ({ ok: true, json: async () => ({ items: [] }) }),
  });
  assert.equal(ok, false);
  assert.equal(read(dir).status, 'error');
  assert.equal(read(dir).lastSuccessfulAt, null);
}));
