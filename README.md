# Cloudflare Scheduler – OSL-Warnfeed

Diese Branch-Vorbereitung ergänzt einen Cloudflare Workers Cron Trigger, der den vorhandenen GitHub-Actions-Workflow update-warnings.yml auslöst. Cloudflare ruft keine Warnquellen direkt ab und schreibt keine JSON-Feeds.

Siehe technische Vorbereitung unter docs/cloudflare-scheduler.md.

Lokale Prüfungen:

- npm test
- npm run bench:cpu

Vor einem echten Einsatz sind Cloudflare-Konto, Worker-Bereitstellung, eine GitHub App mit minimaler Actions: write Berechtigung und deren Private Key als Cloudflare Secret und die gesonderte Umschaltung des GitHub-Crons erforderlich. In dieser Branch wurden keine Zugangsdaten oder produktiven Einstellungen eingerichtet.
