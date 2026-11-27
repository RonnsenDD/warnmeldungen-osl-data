# Cloudflare Cron Trigger – technische Vorbereitungsfassung

## Empfehlung und Betriebsmodell

Empfohlen wird **Cloudflare als externer Taktgeber für den vorhandenen GitHub Actions Workflow**. Der Worker löst alle fünf Minuten workflow_dispatch für update-warnings.yml auf main aus. Abruf, Parser, Validierung, atomare lokale Feed-Erzeugung und Commit bleiben beim bereits getesteten Workflow. Der Worker veröffentlicht selbst keine Warnungsdaten.

Vorteile: keine zweite Parser-Implementierung, keine zweite Feed-Schreibkomponente und kein GitHub-Contents-Schreibrecht für Cloudflare. Nachteil: GitHub Actions bleibt Laufzeit- und Veröffentlichungsweg. Der externe Taktgeber verhindert ausgefallene GitHub-schedule-Ereignisse, kann aber weder eine verzögerte GitHub-Runner-Zuteilung noch GitHub-Ausfälle verhindern.

Der vorhandene GitHub-Cron bleibt in dieser PR absichtlich aktiv. Während eines Übergangs kann es daher zu doppelten Auslösern kommen. Der Worker prüft vor dem Dispatch, ob der Workflow bereits queued oder in_progress ist. Der Workflow hat bereits concurrency.group: warnmeldungen-osl-data und cancel-in-progress: false; beide Trigger laufen also durch dieselbe Actions-Queue. GitHub erlaubt pro Concurrency-Gruppe einen laufenden und einen wartenden Lauf; ein neuer wartender Lauf kann den vorherigen wartenden Lauf ersetzen. Das darf nicht als garantierter 5-Minuten-Abarbeitungstakt missverstanden werden. Nach erfolgreichem externen Beobachtungstest ist eine getrennte Freigabe erforderlich, um den GitHub-Cron in einer späteren Änderung abzuschalten.

## Vergleich der Varianten

| Variante | Vorteile | Grenzen / Berechtigungen |
|---|---|---|
| Cloudflare dispatcht bestehenden Actions-Workflow (implementiert) | Vorhandener Parser und Feed-Writer bleiben maßgeblich; Cloudflare benötigt nur GitHub Actions: write zum Dispatch und Actions: read für queued/running-Prüfung; vorhandene Concurrency-Gruppe bleibt wirksam. | Verarbeitung und Push sind weiterhin von GitHub Actions abhängig. Ein externes Dispatch ist kein Versprechen für sofortige Runner-Zuteilung. Doppelte Auslöser während Übergang; deshalb active-run-Prüfung und gemeinsamer concurrency key. |
| Cloudflare ruft Quellen ab und publiziert per GitHub Git Database API (nicht implementiert) | Abruf, Validierung und Veröffentlichung laufen ohne Actions-Runner; umgeht GitHub-Schedule-/Runner-Queue für den eigentlichen Datenlauf. | Benötigt langlebiges GitHub-Schreibgeheimnis mit Contents: write (und sichere Rotation). Zwei Feed-Dateien müssen in einem Commit atomar aktualisiert werden. Ref-Updates müssen ohne Force erfolgen; bei Konkurrenz sind Remote-Stand neu einzulesen, Frische/Monotonie zu prüfen und Commit neu aufzubauen. Bestehender GH-Workflow wäre paralleler Writer und könnte wegen fehlendem Retry bei Push-Kollisionen fehlschlagen. Größeres Sicherheits- und Betriebsrisiko. |

Für die implementierte Dispatch-Variante ist eine GitHub App mit Zugriff ausschließlich auf Repository warnmeldungen-osl-data und Actions: write zu bevorzugen; diese Berechtigung muss sowohl Dispatch als auch Run-Abfrage abdecken. Der Worker erzeugt je Lauf ein kurzlebiges Installationstoken aus App-ID, Installations-ID und App-Private-Key. Nur der Private Key wird später als Cloudflare Secret abgelegt; es wird kein dauerhaftes PAT und kein statisches Installationstoken benötigt. Die IDs sind nicht geheime Konfigurationswerte. Für eine spätere Direktpublikation wäre zusätzlich Contents: write erforderlich und die App-Berechtigung deutlich breiter.

## Feed-Vertrag und Status

Cloudflare verändert warnungen.json und hochwasser.json nicht. Die bestehende Feed-Struktur mit status, lastAttemptAt, lastSuccessfulAt und items bleibt vollständig beim bestehenden Skript. Der Worker liest nur die öffentlichen Feed-Metadaten und protokolliert Quelle, Feedstatus, Datenalter und Item-Anzahl. Er protokolliert keine Warnungsinhalte, Token, vollständige Fehlerobjekte oder Auth-Header.

Ein status: ok mit items: [] gilt nur dann als leere erfolgreiche Momentaufnahme, wenn ein erfolgreicher Quellabruf vorliegt (lastSuccessfulAt). error, fehlender Zeitstempel, ungültiges JSON, nicht erreichbarer Feed und Alter über 15 Minuten werden als nicht frisch behandelt. Ein Dispatch bestätigt lediglich die Annahme des Workflow-Auftrags (HTTP 204), nicht einen erfolgreichen Lauf oder eine Veröffentlichung.

Der Worker überspringt einen Dispatch bei bereits queued oder in_progress laufendem Workflow. Jede Worker-Ausführung schreibt ein strukturiertes Log mit scheduled_run, Freshness-Zusammenfassungen und Dispatch-Ergebnis. Bei Feedalter über 15 Minuten wird monitor_threshold_exceeded protokolliert. Cron-Lücken selbst sind an fehlenden Worker-Ausführungslogs im Cloudflare-Dashboard erkennbar. Automatische Benachrichtigungen erfordern einen separat freizugebenden Alarmkanal; dieser wird hier nicht eingerichtet.

## Kosten und Limits

Cloudflare Workers Free nennt 100.000 Requests pro Tag, fünf Cron Trigger pro Konto und 10 ms CPU pro Cron-Ausführung. Fünf-Minuten-Takt entspricht maximal 288 Worker-Ausführungen pro Tag. Quell-/Feed-Abfragen und GitHub-API-Aufrufe sind Netzwerkwartezeit; diese zählt laut Cloudflare nicht zur CPU-Zeit. Im implementierten Dispatch-Weg verarbeitet der Worker nur zwei kleine Feed-Metadaten und prüft Actions-Läufe; Warnungsantworten werden weiterhin von GitHub Actions geparst. Für diesen Worker ist die 10-ms-Grenze voraussichtlich gut erreichbar, muss aber nach Deployment anhand der Cloudflare-Runtime-Metrik bestätigt werden.

Das Node-Benchmark in bench/worker-cpu-benchmark.mjs misst synthetische JSON-Parsing-/Array-Validierungsarbeit lokal, nicht die isolatenspezifische Cloudflare-CPU. Es ist ein Belastungsindikator für die nicht implementierte Direktverarbeitung, kein Nachweis für eine Worker-CPU-Grenze. Der kostenlose GitHub-Actions-Tarif und dessen inkludierte Minuten hängen vom Repository-Kontotyp und Plan ab; 288 tatsächliche Actions-Runs täglich können relevante Actions-Minuten verbrauchen. Cloudflare-Runtime und GitHub-Runner sind separate Kosten-/Kontingentstellen. Vor Aktivierung Kontingente im konkreten Cloudflare- und GitHub-Konto prüfen.

## Fehlerfälle und Schutz

- Ungültige oder fehlende Worker-Konfiguration: Lauf endet mit generischem Konfigurationsfehler, keine Geheimnisse in Logs.
- GitHub API nicht erreichbar / nicht autorisiert / kein 204: Dispatch wird als Fehler protokolliert; Warnfeeds werden nicht verändert.
- Actions-Auftrag bereits aktiv oder wartend: Worker dispatcht nicht erneut.
- Feed nicht erreichbar, JSON ungültig, Feedstatus nicht ok, fehlendes lastSuccessfulAt oder Alter über 15 Minuten: niemals Entwarnung ableiten; monitor_threshold_exceeded loggen.
- Erfolgreich geprüfter leerer Feed bleibt status ok und items []; Worker interpretiert ihn nicht als Ausfall.
- Keine neue Datenveröffentlichung durch den Worker; bestehender Workflow behält seine Fehler-/Snapshot-Regeln.

## Spätere manuelle Einrichtung (nicht ausgeführt)

1. Cloudflare-Konto/Workers-Verfügbarkeit und Tarif/Kontingente prüfen; Free-Plan aktivieren, falls im Konto verfügbar und akzeptiert.
2. Den Branch-PR prüfen und mergen.
3. Eine GitHub App ausschließlich für warnmeldungen-osl-data erstellen, nur Actions: write vergeben und als Installation auf dieses Repository beschränken. App-ID und Installation-ID als nicht geheime Worker-Variablen konfigurieren.
4. Den GitHub App Private Key als Cloudflare Secret GITHUB_APP_PRIVATE_KEY ablegen. Der Worker signiert damit pro Lauf ein kurzes JWT und tauscht es gegen ein Installationstoken; Tokenwerte werden nicht protokolliert oder dauerhaft gespeichert. Private Key weder in vars noch Datei, Commit, Log oder Artefakt legen.
5. Worker zunächst ohne Cron Trigger bereitstellen, Secret und Variablen prüfen; anschließend Cron */5 * * * * ergänzen und erneut deployen. So löst der Zeitplan nicht mit fehlender Authentifizierung aus. Cloudflare weist darauf hin, dass Triggeränderungen bis zu 15 Minuten zur Verteilung brauchen.
6. Einen manuellen Worker-Test ausführen und prüfen: workflow_dispatched-Log, GitHub Workflow-Run, Veröffentlichungszeit und beide Feed-Dateien.
7. Mindestens 24 Stunden im Parallelbetrieb beobachten. Vergleichen: Worker-Ticks, Dispatches, Actions-Startzeiten, letzte erfolgreiche Abrufe, items sowie Fehler.
8. Erst nach separater Freigabe den bestehenden GitHub-Schedule aus dem Workflow entfernen; workflow_dispatch bleibt als Notfallweg. Die gemeinsame Concurrency-Konfiguration beibehalten.
9. Einen Test der Stale-Erkennung ausführen und einen Alarmkanal separat festlegen.
10. Rückfall: Worker-Cron deaktivieren/entfernen; bestehenden GitHub-Schedule und manuellen Dispatch weiterverwenden. Keine Feed-Dateien zurücksetzen; bei Fehlern bleibt der letzte gültige Feedstatus sichtbar.

## Aktueller Prüfstand

Der Worker und seine Tests sind lokale Vorbereitung. Kein Cloudflare-Konto, Secret, Trigger, produktiver Worker, Workflow-Run oder Feed wurde angelegt, verändert oder ausgelöst. Tests laufen ausschließlich mit Mock-Antworten und synthetischen Daten.
