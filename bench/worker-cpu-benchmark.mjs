import { performance } from 'node:perf_hooks';

const sizes = [
  { name: 'small', alerts: 20, lhp: 10 },
  { name: 'realistic', alerts: 250, lhp: 100 },
  { name: 'large', alerts: 2500, lhp: 1000 },
  { name: 'stress', alerts: 10000, lhp: 5000 },
];

function alert(i) {
  return {
    id: `fixture-alert-${i}`,
    type: 'ALERT',
    version: 1,
    i18nTitle: { de: { translation: `Synthetische Warnung ${i}` } },
    payload: {
      headline: `Synthetischer Testhinweis ${i}`,
      description: 'Nur Benchmark-Fixture; keine echte Warnmeldung.',
      instruction: 'Keine Handlungsempfehlung, Testinhalt.',
      area: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Testgebiet' }, geometry: { type: 'Polygon', coordinates: [[[13.5, 51.2], [13.8, 51.2], [13.8, 51.4], [13.5, 51.2]]] } }] },
      effective: '2026-10-23T08:00:00Z',
      expires: '2026-10-23T09:00:00Z',
      severity: 'Moderate',
      senderName: 'Synthetische Quelle',
    },
  };
}

function measure(label, value, rounds = 5) {
  let cpuMs = 0;
  let wallMs = 0;
  let bytes = 0;
  let count = 0;
  for (let i = 0; i < rounds; i++) {
    const json = JSON.stringify(value);
    bytes = Buffer.byteLength(json);
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('fixture invalid');
    count = parsed.length;
    const cpu = process.cpuUsage(cpuStart);
    cpuMs += (cpu.user + cpu.system) / 1000;
    wallMs += performance.now() - wallStart;
  }
  return { label, itemCount: count, bytes, rounds, meanCpuMs: +(cpuMs / rounds).toFixed(3), meanWallMs: +(wallMs / rounds).toFixed(3) };
}

for (const size of sizes) {
  const warnings = Array.from({ length: size.alerts }, (_, i) => alert(i));
  const lhp = Array.from({ length: size.lhp }, (_, i) => ({ id: `fixture-flood-${i}`, region: 'synthetic', status: 'test', geometry: alert(i).payload.area }));
  console.log(JSON.stringify({
    fixture: size.name,
    warnings: measure('warning-array-parse-and-shape-check', warnings),
    lhp: measure('lhp-array-parse-and-shape-check', lhp),
  }));
}
