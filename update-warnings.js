const fs = require('node:fs');
const path = require('node:path');

const SOURCES = {
  warnungen: { url: 'https://warnung.bund.de/api31/dashboard/120660000000.json', file: 'warnungen.json' },
  hochwasser: { url: 'https://warnung.bund.de/api31/lhp/mapData.json', file: 'hochwasser.json' },
};

function writeJsonAtomically(filePath, data) {
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temp, filePath);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

async function updateFeed(name, source, options = {}) {
  const filePath = path.join(options.directory || process.cwd(), source.file);
  const now = options.now || (() => new Date().toISOString());
  const fetcher = options.fetcher || fetch;
  const lastAttemptAt = now();
  let previous = { items: [], lastSuccessfulAt: null };
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
    }
  } catch {
    console.error(`${name}: Vorheriger Feed konnte nicht gelesen werden.`);
  }

  try {
    const response = await fetcher(source.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Invalid feed shape');

    const lastSuccessfulAt = now();
    writeJsonAtomically(filePath, {
      status: 'ok',
      fetchedAt: lastSuccessfulAt,
      lastAttemptAt,
      lastSuccessfulAt,
      items,
    });
    console.log(`${name}: erfolgreich, ${items.length} Einträge.`);
    return true;
  } catch (error) {
    const safeError = /^HTTP [0-9]{3}$/.test(String(error?.message || ''))
      ? error.message
      : 'Quellabruf oder Datenprüfung fehlgeschlagen';
    writeJsonAtomically(filePath, {
      status: 'error',
      fetchedAt: lastAttemptAt,
      lastAttemptAt,
      lastSuccessfulAt: previous.lastSuccessfulAt || null,
      items: Array.isArray(previous.items) ? previous.items : [],
      error: safeError,
    });
    console.error(`${name}: ${safeError}.`);
    return false;
  }
}

async function main() {
  let allSucceeded = true;
  for (const [name, source] of Object.entries(SOURCES)) {
    if (!(await updateFeed(name, source))) allSucceeded = false;
  }
  if (!allSucceeded) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    console.error('Feed-Aktualisierung unerwartet fehlgeschlagen.');
    process.exitCode = 1;
  });
}

module.exports = { SOURCES, updateFeed, writeJsonAtomically };
