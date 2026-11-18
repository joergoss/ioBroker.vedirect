![Logo](admin/vedirect.png)

# ioBroker.vedirect

[![Test and Release](https://github.com/joergoss/ioBroker.vedirect/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/joergoss/ioBroker.vedirect/actions/workflows/test-and-release.yml)

Standardmäßig read-only ioBroker-Adapter für Victron-Geräte mit serieller VE.Direct-Schnittstelle. Optional unterstützt er strikt validierte HEX-Gets sowie einzeln freischaltbare SmartSolar-Steuerfunktionen. Dieses Repository ist ein Fork von [DrozmotiX/ioBroker.vedirect](https://github.com/DrozmotiX/ioBroker.vedirect) und enthält eine grundlegende Protokoll- und Lifecycle-Härtung.

## Funktionen

- Byteorientierter, atomarer Parser nach **VE.Direct Protocol 3.34** und offizieller FAQ.
- Modulo-256-Checksumme und Veröffentlichung erst nach einem gültigen vollständigen Block.
- Alle 256 binären Checksumbytes, beliebige Serial-Chunk-Grenzen und mehrere Blöcke.
- Kontrollierte Behandlung asynchroner HEX-Nachrichten und Wiederaufsynchronisation.
- Strikte numerische Validierung; keine stillen `parseFloat`-Teilwerte, kein `NaN` und keine erfundenen Nullen.
- Instanzgebundener SerialPort-12-Lifecycle mit Open-/Set-/Close-Timeouts, Reconnect und Late-Callback-Schutz.
- `info.connection` folgt ausschließlich frischen gültigen Blöcken.
- Objekt-Migration vor State-Schreiben sowie behandelte Promise-Fehler.
- Frame-Sampling ohne Verlust einzelner Protokollfelder.
- Mehrinstanzfähigkeit ohne globale Ports, Parser, Timer oder Buffer.
- Optionaler HEX-Get-Zugriff mit Rev.-18-Checksumme, exakter Response-Zuordnung und fester Registerwhitelist.
- Optionaler Charger-on/off- und dynamischer Charge-Current-Control mit Read-after-Write, Sicherheitsgrenzen und instanzgebundenem Refresh-Supervisor.

## Unterstützte Geräte und Umfang

Die Feldregistry deckt die im bisherigen Adapter enthaltenen BMV-, MPPT-, Phoenix- und Orion-Felder ab, einschließlich SmartSolar-, SmartShunt- und VE.Direct-Phoenix-Daten. Die tatsächliche Feldverfügbarkeit hängt von Produkt und Firmware ab.

Der Adapter bleibt standardmäßig **read-only**. HEX-Gets und die Steuerfunktionen sind einzeln deaktiviert vorkonfiguriert. Es gibt keine allgemeine Roh-Register-, BMS-/Slave-, Spannungs- oder persistente Batterieeinstellungs-Steuerung. Details und Sicherheitsgrenzen stehen in [docs/hex-control.md](docs/hex-control.md).

Offizielle Referenzen:

- [VE.Direct Protocol 3.34](https://www.victronenergy.com/upload/documents/VE.Direct-Protocol-3.34.pdf)
- [VE.Direct Protocol FAQ](https://www.victronenergy.com/live/vedirect_protocol:faq)

Für den realen Betrieb von zwei SmartSolar-MPPTs einschließlich State-Übersicht und später möglicher HEX-Schreiboptionen siehe [docs/two-mppt.md](docs/two-mppt.md).

## Konfiguration

### Serielle Schnittstelle

Den Gerätepfad eintragen, beispielsweise `/dev/ttyUSB0` oder einen stabilen `/dev/serial/by-id/...`-Pfad. Der Adapter verwendet **19200 Baud, 8N1**. Vor dem Start darf kein anderer Prozess denselben Port verwenden.

### State-Ablaufzeit (`expireTime`)

- `0`: Keine TTL; unveränderte Werte werden mit echter Changed-Optimierung behandelt.
- Größer `0`: Bei als flüchtig markierten Messfeldern wird die TTL mit gültigen Frames erneuert.
- Statische Identifikations-/Statusfelder besitzen je nach Felddefinition keine TTL.

Die Ablaufzeit sollte bei aktiviertem Sampling deutlich größer als das Samplingintervall sein.

### Frame-Sampling (`messageBuffer`)

Der bisherige Konfigurationsname bleibt aus Kompatibilitätsgründen erhalten, das Verhalten ist korrigiert:

- `0`: Jeder gültige Block wird verarbeitet.
- Größer `0`: Serielle Daten werden weiterhin vollständig geparst; für die State-Publikation werden vollständige Blöcke über das Intervall zusammengeführt. Der jeweils letzte Wert jedes Felds wird anschließend geschrieben.
- Liveness und Reconnect werden durch Sampling nicht gedrosselt.
- Bei erkanntem Verbindungsverlust wird ein noch nicht veröffentlichter Sample-Puffer verworfen; nach einem Reconnect beginnt ein neuer Puffer, sodass keine Werte über Verbindungsgrenzen hinweg vermischt werden.
- Es werden keine einzelnen Zeilen oder History-Blöcke mehr verworfen.

### Optionaler HEX-Zugriff

Alle HEX-Funktionen sind standardmäßig deaktiviert. `hexReadEnabled` erlaubt ausschließlich eine feste Whitelist von Registerabfragen. `chargerControlEnabled` und `currentLimitControlEnabled` schalten die jeweiligen `control.*`-States separat frei.

Die Stromsteuerung benötigt zusätzlich `currentLimitMax` als Adapter-Sicherheitsobergrenze und erneuert External-Control-Modus und Limit alle `currentLimitRefreshSeconds` (5–50 Sekunden) mit Read-after-Write. Ein Kommunikationsverlust ist **kein Fail-safe-Off**: Das Gerät kann auf Stand-alone und sein persistentes Maximalstrom-Setting zurückfallen.

Siehe [docs/hex-control.md](docs/hex-control.md) für States, Transaktionssemantik und das read-only Diagnoseprogramm.

## Verbindungs- und Fehlerverhalten

- `info.connection=true`: Innerhalb der letzten zehn Sekunden wurde ein checksumgültiger Block empfangen.
- `info.connection=false`: Kein frischer gültiger Block, Open-/Serial-Fehler oder Adapterstopp.
- Bei Datenstopp oder Disconnect wird der Port kontrolliert geschlossen und mit Cooldown erneut geöffnet.
- Ungültige Checksummen und malformed bekannte Werte verändern keine Mess-States.
- Nach erkanntem Verbindungsverlust werden keine gepufferten Werte mehr quittiert und keine TTL erneuert.
- Wiederholte identische Serialfehler werden im Log gedrosselt.
- Beim Unload wird vor dem Abschluss `info.connection=false` quittiert; der Unload-Abschluss ist zeitlich begrenzt, damit ein hängender Serial- oder Datenbankvorgang den Adapterstopp nicht blockiert.

## Sonderwerte und Decodierung

| Eingabe                    | Verhalten                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `---`                      | `null`; kein `NaN` oder Pseudo-Nullwert                                              |
| `TTG=-1`                   | `TTG=null`, zusätzlich `TTGInfinite=true`                                            |
| Normales TTG               | Weiterhin Minuten zur Wahrung der bestehenden State-API                              |
| `FW` / `FWE`               | Strings; führende Nullen und Release-/Beta-Kennungen bleiben erhalten                |
| `AR` / `WARN` / `OR`       | Alle gesetzten Bits werden gemeinsam decodiert; unbekannte Restbits bleiben sichtbar |
| `Alarm` / `Relay` / `LOAD` | Case-insensitive, kanonische `ON`/`OFF`-Strings ohne bisherigen Typwechsel           |
| Unbekanntes Feld           | Kein State; bekannte Werte desselben gültigen Blocks bleiben erhalten                |

## Migration und Kompatibilität

Bestehende State-IDs bleiben grundsätzlich erhalten. Objektdefinitionen werden beim ersten gültigen Empfang des jeweiligen Felds aktualisiert; Custom-Settings etwa für History/InfluxDB bleiben erhalten.

Wichtige Korrekturen gegenüber 0.1.2/0.3.x:

- `PPV`, `H21`, `H23`, `HSDS` und weitere numerische Felder werden zuverlässig als Zahlen geschrieben.
- `H15`/`H16` besitzen nach der vorhandenen Umrechnung korrekt die Einheit `V` statt `mV`.
- Energiezähler verwenden `kWh` und Energie-Rollen.
- `FW`/`FWE` werden zur Erhaltung ihrer Protokollsemantik als Strings migriert.
- `TTGInfinite` ist ein neuer synthetischer State.
- Bereits historisch gespeicherte Werte werden nicht rückwirkend verändert.

## Entwicklung und Tests

Voraussetzungen: Node.js 22 oder neuer, js-controller ≥6.0.11 und Admin ≥7.6.20.

```bash
npm ci
npm run test:all
```

`test:all` umfasst die fachliche Suite, Package-Checks, `checkJs`, ESLint und js-controller-Integration. Die CI-Matrix verwendet Node.js 22/24/26 auf Linux, Windows und macOS.

Die Tests umfassen unter anderem den exakten offiziellen FAQ-Frame, alle Chunk-Grenzen und Checksumbytes, HEX/Multiblock/Recovery, reale SmartSolar- und BMV-Vektoren, Serial-Fehler und hängende native Callbacks, State-/TTL-/Sampling-Verhalten sowie getrennte Instanzen.

Der vollständige Audit steht in [docs/audit-2026-11-17.md](docs/audit-2026-11-17.md).

## Dependency-Audit

Der Produktions-Audit ist ohne Befund. Im Entwicklungs-Toolchain-Audit verbleibt eine transitive `picomatch`-ReDoS-Meldung über `tinyglobby`/TypeScript-ESLint, für die zum Prüfzeitpunkt keine korrigierte kompatible Release-Kette verfügbar ist. Sie betrifft ausschließlich Entwicklungs-Globbing mit potenziell bösartigen Patterns, nicht den Adapterbetrieb oder die VE.Direct-Verarbeitung.

## Changelog
### **WORK IN PROGRESS**

- (joerg) Optionaler HEX-Get-Client mit offiziellen Rev.-18-Fixtures, strenger Register-/Response-Prüfung und read-only Hardwareprobe.
- (joerg) Optionaler Charger-on/off- und dynamischer Charge-Current-Control mit Read-after-Write, Capability-Gate und begrenzten Queues.
- (joerg) Instanzgebundener Stromlimit-Supervisor, Session-Invalidierung ohne blindes Retry sowie umfangreiche Fake-/Serial-/Zwei-Instanz-Tests.

### 0.4.0 (2026-11-18)

- (joerg) Atomarer VE.Direct-3.34-Parser mit Checksum-, HEX-, Multiblock- und Recovery-Tests (#1).
- (joerg) Feldskalierungen, Sentinels, Bitfelder, Firmwaretypen, Rollen und Metadaten korrigiert (#1).
- (joerg) Instanzgebundener SerialPort-12-Lifecycle, Reconnect, sichere State-Queues und Unload (#2).
- (joerg) Frame-Sampling, Expire-/Changed-Verhalten und Mehrinstanzbetrieb korrigiert (#2).
- (joerg) Dummy-Test durch reale Protokoll-/Lifecycle-/Adaptertests ersetzt; CI und Dokumentation erweitert (#3).
- (joerg) Node.js 22+ vorausgesetzt, CI auf Node.js 22/24/26 erweitert und Release-Tooling modernisiert.

### 0.3.3 (2024-09-10)

- (DutchmanNL) Repository checker compliance updates.
- (DutchmanNL) Update dependencies for Node.js 18+ compatibility.

### 0.3.1 (2023-10-29)

- (DutchmanNL) Message buffer implemented; im Fork durch verlustfreies Frame-Sampling ersetzt.

### 0.3.0 (2023-08-07)

- (DutchmanNL/Andiling) Protocol 3.33 und Bugfixes.

### 0.2.0 (2023-08-06)

- (DutchmanNL/Andiling) Protocol 3.32, Produktnamen und konfigurierbare State-Ablaufzeiten.

### 0.1.2 und älter

- Ursprüngliche Releases von DutchmanNL/Andiling; siehe Upstream-Historie.

## Sentry

Das ioBroker-Sentry-Plugin bleibt konfiguriert. Details und Deaktivierung sind in der [Sentry-Plugin-Dokumentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry) beschrieben.

## License

MIT License — ursprünglich Copyright DutchmanNL und Mitwirkende; siehe [LICENSE](LICENSE).
