# Reproduzierbare TCP-/Reconnect-Soak-Tests (#11)

Stand: 2026-11-21, Entwicklungsbranch `feat/soak-tests`.

## Ziel und Sicherheitsgrenzen

Das separate Messprogramm `test/soak/run.js` startet echte Adapterlogik gegen echte Loopback-TCP-Server. Es verwendet weder fremde öffentliche Endpunkte noch physische Serialports und verändert keine Produktivkonfiguration. Alle Szenarien erzeugen ausschließlich TEXT-Eingaben. Der Server zählt zusätzlich alle vom Adapter empfangenen Bytes; das Pass-Kriterium verlangt **null Client-Bytes** und damit nachweislich keine HEX-Gets/Sets oder anderen Geräte-Schreibzugriffe.

Die Testdateien liegen außerhalb des Produktivpakets. Es gibt keinen Dauerlauf in der normalen CI. Der kurze Lauf ist Teil von `test:all`, des Release-`before_commit`-Hooks und des eigenen `soak-short`-CI-Jobs.

## Szenarien

| Szenario | Reales Ereignis und Erwartung |
|---|---|
| `fin` | Der Server beendet die TCP-Verbindung kontrolliert. Ein erfolgreicher Reconnect mit frischen gültigen Frames ist erforderlich. |
| `rst` | Der Server verwendet `socket.resetAndDestroy()`. Vor der Recovery muss der Adapter nachweislich `ECONNRESET` beobachten; danach sind neue Server-Verbindung, Session und gültige Frames erforderlich. |
| `dns` | `nonexistent.invalid.` liefert einen echten DNS-Fehler. Anschließend muss derselbe reservierte Fehler sichtbar sein und der erste erfolgreiche Open nach Korrektur ohne Reconnect-Zähler erfolgen. Der absolute Name vermeidet Suchdomain-Abhängigkeit; die Auflösung bleibt dennoch vom Systemresolver abhängig und wird nicht künstlich ersetzt. |
| `stop` | Der Server hält die Verbindung offen und stoppt die Frames. Erst nach Reconnect-Zähler und neuer Server-Akzeptanz werden Frames wieder gesendet; danach sind neue Session und frische Payloads erforderlich. Dadurch gibt es kein Timingfenster für eine versehentlich wieder frische alte Verbindung. |
| `independent` | Zwei Adapter-/Serverpaare laufen gleichzeitig. Nur A erhält FIN; B muss verbunden und ohne Reconnect bleiben. |
| `short` | Führt `fin`, `rst`, `dns`, `stop` und `independent` je einmal in getrennten Paaren aus. |
| `cycle` | Wiederholt dieselbe Folge bis zur gewählten Dauer und räumt nach jedem Szenario vollständig auf. Mindestens ein vollständiger Zyklus wird ausgeführt. |

## Aufruf

Kurzlauf wie in der CI:

```sh
npm run test:soak
```

Manueller Langlauf mit Bericht:

```sh
npm run test:soak -- --scenario=cycle --duration=3600 --sample=10 --output=/tmp/vedirect-soak.json
```

- `--duration`: 30–86400 Sekunden; auch kurze Werte führen mindestens einen vollständigen Zyklus aus.
- `--sample`: 1–300 Sekunden zwischen periodischen Ressourcenmessungen.
- `--output`: optionaler JSON-Berichtspfad. Zusätzlich wird der vollständige Bericht auf stdout geschrieben.
- Einzelszenarien sind für gezielte Analyse möglich, beispielsweise `--scenario=fin` oder `--scenario=stop`.
- `SIGINT`/`SIGTERM` brechen Szenario-Waits und Delays über `AbortController` ab. Erst nachdem das aktive Szenario zurückgerollt ist, erfolgen genau einmal Cleanup, finale Messung und Bericht. Auch bereits registrierte, teilinitialisierte Paare werden aufgeräumt. Der Bericht enthält `aborted: true` sowie die jeweiligen Signal-Exitcodes.

PTY-/physische Serialszenarien sind in dieser Stufe nicht erforderlich und werden nicht gestartet. Dadurch ist ausgeschlossen, dass zwei Prozesse versehentlich denselben physischen Serialport öffnen.

## Messwerte

- `heapUsed`, `heapTotal` und RSS in MiB,
- aktive Node-Ressourcen nach Typ (`TCPSocket`, `Timeout`, `Immediate` und weitere),
- Session-ID, erfolgreiche Opens, Reconnect-Zähler und Framezeitpunkt,
- aktiver Watchdog/Timer, State-Queues, Diagnose-Drains und offene Server-Sockets,
- State-Writes und deren endliche Werte,
- Client-Bytes und Server-Akzeptanzzähler,
- Szenarioereignisse, Dauer und Fehlerbilder.

Der JSON-Bericht enthält `passed`, `aborted`, `parameters`, `baseline`, `final`, `droppedSamples`, `events`, `samples` und `errors`. Höchstens 2000 Messpunkte werden als Ringpuffer vorgehalten; `droppedSamples` dokumentiert verworfene ältere Messpunkte und begrenzt den Speicherbedarf des Berichts auch bei 86400 Sekunden Laufzeit und einsekündigem Sampling. Die finalen Speicherwerte stammen aus dem Median dreier Messungen im Abstand von je 100 ms im Ruhezustand nach Cleanup, nicht aus einer einzelnen GC-abhängigen Momentaufnahme.

## Pass/Fail-Kriterien

Ein Lauf besteht nur, wenn alle erwarteten Reconnects und DNS-/Unabhängigkeitsereignisse eintreten, Cleanup vollständig ist, keine unerwarteten Adapterfehler oder nicht-finiten Werte auftreten und keine Client-Bytes empfangen wurden. Zusätzlich gelten nach dem letzten Cleanup gegenüber der Prozess-Baseline folgende Grenzen:

| Messgröße | Zulässiges Wachstum |
|---|---:|
| `heapUsed` | höchstens 16 MiB |
| RSS | höchstens 32 MiB |
| aktive `TCPSocket`/`TCPSocketWrap` | exakt +0 |
| aktive `TCPServer`/`TCPServerWrap` | exakt +0 |
| aktive `Timeout` | höchstens +2 |
| aktive `Immediate` | höchstens +4 |

Nach jedem Szenario müssen Port, Watchdog-Interval, aktive Watchdog-Operation, Current-Limit-Timer, Pending-Frame-Batch, State-Queues und Diagnose-Drains beendet beziehungsweise leer sein. Die finale Ressourcenmessung verwendet drei Snapshots im Abstand von je 100 ms, damit bereits geschlossene Server-Wrapper auch aus Node’s aktiver Ressourcenliste verschwunden sind und nicht fälschlich als Leak erscheinen. Ressourcenwachstum oberhalb dieser Grenzen sowie hängige Sessions gelten als Fehler und setzen `passed: false` beziehungsweise Exitcode 1. Abgebrochene Läufe sind unabhängig von erfolgreichem Cleanup `passed: false` und behalten ihre spezifischen Exitcodes 130/143.

Reconnects werden nicht allein aus Adapterzählern abgeleitet: Neue Server-Akzeptanzzahlen, geänderte Session-IDs, neuere gültige Framezeitpunkte und mindestens eine echte `V`-Payload sind Pflicht. Adapter- und Serverfehler werden pro Szenario nur als ausdrücklich erwartete Transportfehler akzeptiert; jede andere Fehlerklasse führt zum Fehlschlag.
