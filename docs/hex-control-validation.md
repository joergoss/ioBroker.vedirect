# Validierung des optionalen HEX-Zugriffs

Stand: 2026-11-18, Entwicklungs- und Prüfbranch `feat/hex-control`.

## Automatisierte Prüfungen

Finaler Kandidat `a6803f1`:

- `npm run test:all` vollständig bestanden.
- **379 Tests** im fachlichen JS-/Package-Teil.
- **324 Tests** im js-controller-Integrationsteil.
- TypeScript/checkJs bestanden.
- ESLint: 0 Fehler; 48 nicht blockierende JSDoc-Warnungen im vorhandenen Stil.
- Produktions-Dependency-Audit: 0 Befunde; keine neue Runtime-Dependency.
- Paket isoliert auf pi4/ARM64/Node 24.22.3 mit SerialPort-12-Binding geladen.

## Protokoll- und Transportabdeckung

- 54 Codec-Tests mit offiziellen Rev.-18-Fixtures, allen 256 Flagkombinationen, allen 256 Checksummenbytes und deterministischen Zufallsframes.
- 81 Registry-Tests für IDs, Breiten, Little-Endian, Skalierungen, Enums, Capabilities und Schreibverbote.
- 33 Transaktionsclient-Tests für Response-Matching, frühe Antworten, Fehlerflags, Echo-Mismatch, Timeout, Cancel, Reconnect und zwei Clients.
- 13 echte Parser-/Com-/Client-Fake-Serial-Integrationsszenarien einschließlich aller ausgewählten Chunk-Grenzen.
- 8 native POSIX-PTY-Szenarien mit SerialPort 12 und unabhängigem Python-Codec; zusätzlich 80/80 in zehn Wiederholungsläufen.
- 58 Adapter- und Control-Tests für Opt-ins, State-Migration, Capability-Gate, Readbacks, Supervisor, Disconnect, Unload und Zwei-Instanz-Verhalten.

## Unabhängiges Audit und Gegenmaßnahmen

Die Abschlussreview reproduzierte sechs zunächst nicht abgedeckte Fälle. Alle wurden mit eigenen Regressionen behoben:

| Befund | Behandlung |
|---|---|
| Stromlimit-Set nach Disconnect | Feste Verbindungsgeneration plus Frische-/Portprüfung nach jedem Await; `cancel()` invalidiert und schließt die Session |
| Alte Capability reaktiviert Gate nach Disconnect | Erneute Generationsprüfung nach State-Publikation; neue Capability pro Verbindung |
| Pre-cancel-Response bestätigt neue Operation | Sessioninvalidierung und Close auch für `cancel()`; neue Writes erst nach Reconnect |
| Supervisor wird nach Unload wieder aktiv | Unload-/Generationsprüfung nach dem Strom-State-Write; Timerstart zusätzlich verriegelt |
| Kompletter TEXT-Block nach Abbruch verschluckt | Begrenzte Recovery nur für unmittelbaren CRLF-Kandidaten mit allen Struktur-/Wert-/Checksummenprüfungen |
| Charge Master `0x21` abgelehnt | Read-only-Dekodierung als `chargeMaster`; Schreiben weiterhin auf Standalone/External beschränkt |

Zusätzlich wurde Auto-Resume nach Reconnect verworfen: Nach Verbindungsverlust sind Timer und bestätigter Sollwert gelöscht. Eine Stromsteuerung benötigt immer eine neue ausdrückliche Bestätigung.

## PTY-spezifische Plattformgrenzen

- macOS kann das Modem-Control-Setzen eines `os.openpty()`-Slaves mit `ENOTTY` ablehnen; der Harness ignoriert nur diesen hardwarebezogenen PTY-Fehler. Open, Lock, Read, Write, Drain und Close bleiben nativ.
- Node 26 benötigt nach echtem `readable` gelegentlich einen `setImmediate`-Turn für die Promise-Fortsetzung. Es werden keine Bytes oder Reads ersetzt.
- macOS liefert nach Master-Close wiederholt `read() = 0`, ohne dass SerialPort 12 daraus einen Close erkennt. Der PTY-Reconnect verwendet dort explizit `VeDirectCom.close()`; unter Linux bleibt der native Hangup-Pfad aktiv.

Diese Grenzen betreffen PTYs und werden nicht als Victron-Geräteverhalten interpretiert.

## Reale Hardwareprüfung

Reale Set-Befehle wurden noch nicht gesendet. Die folgenden Nachweise wurden am 2026-11-18 mit der Get-only-Probe auf pi4/ARM64/Node 24.22.3 erhoben. Die jeweilige 0.4.0-Instanz wurde kontrolliert gestoppt, der Port exklusiv geöffnet und die Instanz anschließend erneut gestartet. Beide Produktivinstanzen liefern danach wieder frische TEXT-Werte ohne neue Fehler.

| Instanz | Get-only | Capability / Register | Set-Tests |
|---|---|---|---|
| `vedirect.0` / MPPT `HQ2128GXFZP` | Alle 8 Register fehlerfrei | Capabilities `0x0809EF76`, External-Control-Bit 15 aktiv; Device Mode ein; Remote-On/Off `2`; Stand-alone; persistent 50 A | ausstehend, Parser-Gate |
| `vedirect.1` / MPPT `HQ2147CUA2K` | Alle 8 Register fehlerfrei | Identische Fähigkeiten und Modi; persistent 50 A | ausstehend, Parser-Gate |

Beide Geräte melden im ungesteuerten Zustand `0xFFFF` für `chargeCurrentLimit` und `chargeVoltageSetpoint`. Die erste Probe zeigte dies roh als 6553.5 beziehungsweise 655.35. Diese Werte sind Sentinel-Markierungen für ungenutzte Remote-Sollwerte und werden im Adapter inzwischen als `null` veröffentlicht. `0xFFFF` ist als Steuerwert gesperrt; `maxBatteryCurrent` bleibt davon unberührt und wurde korrekt als 50 A gelesen.

Der unabhängige Abschlussreview bestätigte vor den realen Gets alle sechs ursprünglichen Control-Fixes. Eine zusätzlich entdeckte TEXT-CRLF-Suffix-Mehrdeutigkeit bleibt ein Gate für reale Set-Tests und Release, beeinflusst aber nicht die strenge HEX-Get-Decodierung dieser Nachweise.
