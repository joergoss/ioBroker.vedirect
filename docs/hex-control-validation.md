# Validierung des optionalen HEX-Zugriffs

Stand: 2026-11-18, Entwicklungs- und Prüfbranch `feat/hex-control`.

## Automatisierte Prüfungen

Finaler Kandidat `58f5d68`:

- `npm run test:all` vollständig bestanden.
- **385 Tests** im fachlichen JS-/Package-Teil.
- **330 Tests** im js-controller-Integrationsteil.
- TypeScript/checkJs bestanden.
- ESLint: 0 Fehler; 48 nicht blockierende JSDoc-Warnungen im vorhandenen Stil.
- Produktions-Dependency-Audit: 0 Befunde; keine neue Runtime-Dependency.
- Paket isoliert auf pi4/ARM64/Node 24.22.3 mit SerialPort-12-Binding geladen.

## Protokoll- und Transportabdeckung

- 54 Codec-Tests mit offiziellen Rev.-18-Fixtures, allen 256 Flagkombinationen, allen 256 Checksummenbytes und deterministischen Zufallsframes.
- 84 Registry-Tests für IDs, Breiten, Little-Endian, Skalierungen, Enums, Capabilities, reale Sentinels und Schreibverbote.
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
| Alter prüfsummengültiger CRLF-Suffix nach Nullsummen-Präfix | Präfix-Checksumme bleibt erhalten; nicht eindeutig zuordenbare Suffixe werden fail-closed verworfen, spätere eindeutige Blöcke resynchronisieren |
| Charge Master `0x21` abgelehnt | Read-only-Dekodierung als `chargeMaster`; Schreiben weiterhin auf Standalone/External beschränkt |

Zusätzlich wurde Auto-Resume nach Reconnect verworfen: Nach Verbindungsverlust sind Timer und bestätigter Sollwert gelöscht. Eine Stromsteuerung benötigt immer eine neue ausdrückliche Bestätigung.

## PTY-spezifische Plattformgrenzen

- Die GitHub-macOS-Jobs wurden wiederholt ohne Runner und ohne Schritte abgebrochen (`runner_id: 0`, `steps: []`). Das ist kein Testfehler. Zur Absicherung wurde `npm run test:all` auf demselben macOS-Host zusätzlich mit **Node 22.23.5** und **24.22.3** ausgeführt; beide vollständigen Läufe mit 385 JS-/Package- und 330 Integrationstests waren erfolgreich. Node 26 wurde lokal ebenfalls mit `npm run test:all` geprüft.
- macOS kann das Modem-Control-Setzen eines `os.openpty()`-Slaves mit `ENOTTY` ablehnen; der Harness ignoriert nur diesen hardwarebezogenen PTY-Fehler. Open, Lock, Read, Write, Drain und Close bleiben nativ.
- Node 26 benötigt nach echtem `readable` gelegentlich einen `setImmediate`-Turn für die Promise-Fortsetzung. Es werden keine Bytes oder Reads ersetzt.
- macOS liefert nach Master-Close wiederholt `read() = 0`, ohne dass SerialPort 12 daraus einen Close erkennt. Der PTY-Reconnect verwendet dort explizit `VeDirectCom.close()`; unter Linux bleibt der native Hangup-Pfad aktiv.

Diese Grenzen betreffen PTYs und werden nicht als Victron-Geräteverhalten interpretiert.

## Reale Hardwareprüfung

Reale Set-Befehle wurden noch nicht gesendet. Die folgenden Nachweise wurden am 2026-11-18 mit der Get-only-Probe auf pi4/ARM64/Node 24.22.3 erhoben. Die jeweilige 0.4.0-Instanz wurde kontrolliert gestoppt, der Port exklusiv geöffnet und die Instanz anschließend erneut gestartet. Beide Produktivinstanzen liefern danach wieder frische TEXT-Werte ohne neue Fehler.

| Instanz | Get-only | Capability / Register | Set-Tests |
|---|---|---|---|
| `vedirect.0` / MPPT `HQ2128GXFZP` | Alle 8 Register fehlerfrei | Capabilities `0x0809EF76`, External-Control-Bit 15 aktiv; Device Mode ein; Remote-On/Off `2`; Stand-alone; persistent 50 A | **Erfolgreich:** Charger Aus/Ein; External 50 A → 10 A → 50 A → Stand-alone |
| `vedirect.1` / MPPT `HQ2147CUA2K` | Alle 8 Register fehlerfrei | Identische Fähigkeiten und Modi; persistent 50 A | Keine Sets ausgeführt |

Beide Geräte melden im ungesteuerten Zustand `0xFFFF` für `chargeCurrentLimit` und `chargeVoltageSetpoint`. Die erste Probe zeigte dies roh als 6553.5 beziehungsweise 655.35. Diese Werte sind Sentinel-Markierungen für ungenutzte Remote-Sollwerte und werden im Adapter inzwischen als `null` veröffentlicht. `0xFFFF` ist als Steuerwert gesperrt; `maxBatteryCurrent` bleibt davon unberührt und wurde korrekt als 50 A gelesen.

Der unabhängige Abschlussreview bestätigte vor den realen Gets alle sechs ursprünglichen Control-Fixes. Die zusätzlich entdeckte TEXT-CRLF-Suffix-Mehrdeutigkeit wurde vor den Set-Tests ebenfalls behoben und über 61 Split-Positionen sowie 256 Orphan-Bytes erneut bestätigt.

## Reale kontrollierte Set-Validierung

Nach ausdrücklicher Benutzerfreigabe wurde MPPT 1 einmalig mit dem finalen Paket getestet. MPPT 2 blieb unverändert. Das Protokoll enthält alle TX-/RX-Frames und Set-Echos:

- Charger Aus: `:80002000447`, Readback `false`.
- Charger Ein: `:8000200014A`, Readback `true`.
- External Control: `:80E2000051A`, Readback `external`.
- 50 A: `:8152000F40123`, Readback 50 A.
- 10 A: `:81520006400B4`, Readback 10 A.
- Erneut 50 A und Stand-alone: `:80E2000001F`, Readback `standalone`.

Final blieben Device Mode `true`, Network Mode `standalone`, persistentes Maximum 50 A und Spannungssollwert `null`. `chargeCurrentLimit` blieb nach Stand-alone als zuletzt gelesener Wert 50 A erhalten, ohne die persistente Einstellung zu verändern. Es wurden keine Fehler, Timeouts oder Wiederherstellungs-Sets benötigt. Beide Produktivinstanzen wurden anschließend mit frischen TEXT-Werten erneut bestätigt.

Die abschließende unabhängige Gegenprobe zu `58f5d68` bestätigte sämtliche ursprünglichen und neuen Parser-/Control-Reproduktionen als behoben, einschließlich keines automatischen Supervisor-Resume und korrekter Sentinel-/Null-Behandlung.
