
const fs = require("node:fs");
const path = require("node:path");

const SOURCES = {
  warnungen: {
    url: "https://warnung.bund.de/api31/dashboard/120660000000.json",
    file: "warnungen.json",
  },
  hochwasser: {
    url: "https://warnung.bund.de/api31/lhp/mapData.json",
    file: "hochwasser.json",
  },
};

async function updateFeed(name, source) {
  const filePath = path.join(process.cwd(), source.file);
  const attemptedAt = new Date().toISOString();

  let previous = {
    items: [],
    lastSuccessfulAt: null,
  };

  try {
    if (fs.existsSync(filePath)) {
      previous = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (error) {
    console.error(`Vorhandener Feed ${name} konnte nicht gelesen werden.`);
  }

  try {
    const response = await fetch(source.url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("Unerwartetes Datenformat: Array erwartet");
    }

    const result = {
      status: "ok",
      fetchedAt: attemptedAt,
      lastSuccessfulAt: attemptedAt,
      items: data,
    };

    fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + "\n");
    console.log(`${name}: erfolgreich, ${data.length} Einträge.`);
  } catch (error) {
    const result = {
      status: "error",
      fetchedAt: attemptedAt,
      lastSuccessfulAt: previous.lastSuccessfulAt || null,
      items: Array.isArray(previous.items) ? previous.items : [],
      error: String(error.message || error),
    };

    fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + "\n");
    console.error(`${name}: Abruf fehlgeschlagen: ${result.error}`);
  }
}

async function main() {
  for (const [name, source] of Object.entries(SOURCES)) {
    await updateFeed(name, source);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
