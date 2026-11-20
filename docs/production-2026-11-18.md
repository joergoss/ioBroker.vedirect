# VE.Direct 0.4.0 – Produktivnachweis 2026-11-18

## Release und Zielsystem

- Fork-PR #4 wurde nach 10/10 relevanten grünen CI-Checks gemergt.
- Release: [`v0.4.0`](https://github.com/joergoss/ioBroker.vedirect/releases/tag/v0.4.0), Release-Commit `fa4aaa45e6fc698b9615bf960628a18c924d477e`.
- Der Release-Prozess führte erneut `npm run test:all` aus: 93 fachliche Tests, Package/Schema, TypeScript, ESLint ohne Fehler und Integration bestanden.
- Kein NPM-Publishing; Installation aus dem Git-Tag beziehungsweise dessen HTTPS-Tarball.
- Ziel ausschließlich pi4, Docker-Container `iob_iobroker`, ioBroker-Host `iobroker`, ARM64, Node.js 24.22.3.
- pi3 wurde nicht verändert; dort läuft kein produktiver VE.Direct-Adapterprozess. Der separate BMV-Adapter bleibt unberührt.

## Installation

Der reguläre GitHub-URL-Installer benötigte im Container einen nicht vorhandenen SSH-Client. Der HTTPS-Tarball-Versuch stieß außerdem auf einen fehlgeschlagenen Neuaufbau des alten SerialPort-9-Pakets; NPM rollte diesen Versuch zurück und beide 0.1.2-Instanzen liefen unverändert weiter.

Ein isolierter Test auf demselben pi4/ARM64/Node-24-System bestätigte 0.4.0 mit SerialPort 12.0.0 und funktionierendem nativem Binding ohne Install-Skripte. Danach erfolgte die Produktivinstallation aus demselben unveränderten Tag:

```sh
docker exec -e npm_config_ignore_scripts=true iob_iobroker \
  iobroker url https://codeload.github.com/joergoss/ioBroker.vedirect/tar.gz/refs/tags/v0.4.0 vedirect
```

Der Installer lud die Admin-Dateien hoch und aktualisierte `system.adapter.vedirect.0` und `system.adapter.vedirect.1` auf 0.4.0. Die temporäre isolierte Testinstallation wurde anschließend entfernt.

## Laufzeit und Gerätezuordnung

| Instanz | Version | Serialport | SerialPort-Bibliothek | Gerät | Seriennummer | Firmware |
|---|---|---|---|---|---|---|
| `vedirect.0` | 0.4.0 | `/dev/ttyUSB-VE-1` | 12.0.0 | SmartSolar MPPT 100/50 | `HQ2128GXFZP` | `174` |
| `vedirect.1` | 0.4.0 | `/dev/ttyUSB-VE-2` | 12.0.0 | SmartSolar MPPT 100/50 | `HQ2147CUA2K` | `174` |

Beide Instanzen sind aktiviert, dem Host `iobroker` zugeordnet und laufen mit getrennten Prozessen und Serialports. Sämtliche bisherigen `native`-Einstellungen blieben erhalten. Neu ist ausschließlich der dokumentierte Standard `messageBuffer: 0`.

## Reale Werte nach kontrolliertem Restart

Um 13:28 Uhr wurden beide 0.4.0-Instanzen kontrolliert neu gestartet. Die alten Prozesse beendeten sich jeweils mit `ADAPTER_REQUESTED_TERMINATION` (Code 11), ohne SIGKILL und ohne neue Unload-, Parser- oder Typfehler. Der Wiederanlauf erfolgte mit den PIDs 47043 und 47078.

| State | `vedirect.0` | `vedirect.1` |
|---|---:|---:|
| `info.connection` | `true`, ack, q=0 | `true`, ack, q=0 |
| `V` | 13.78 V | 13.78 V |
| `VPV` | 46.98 V, frisch | 47.41 V, frisch |
| `PPV` | 0 W | 0 W |
| `I` | 0 A | 0 A |
| `CS` | Float | Float |
| `MPPT` | Voltage or current limited | Voltage or current limited |
| `ERR` | No Error | No Error |
| `OR` | Normal Operation | Normal Operation |
| `H19` | 2148.29 kWh | 1443.18 kWh |

Die unveränderten Werte werden wegen der Changed-Optimierung nicht bei jedem Block neu geschrieben; die Frische wurde deshalb zusätzlich über die sich ändernden VPV-Werte und `info.connection` geprüft. Beide Seriennummern und getrennten Verlaufswerte blieben nach dem Restart korrekt zugeordnet.

## Objekt-Migration und automatische Assertions

Für beide Instanzen wurden die vorhandenen State-IDs und folgende korrigierte Datentypen nachgewiesen:

- V, I, VPV, PPV, H19–H23 und HSDS: `number` mit endlichen Werten.
- FW, PID, SER#, CS, MPPT, ERR, OR und LOAD: `string`.
- `info.connection`: `boolean`.
- Alle geprüften States: `read: true`, `write: false`, `ack: true`, `q: 0`.
- Keine NaN-/Infinity-Werte und keine neuen Typwarnungen nach dem 0.4.0-Restart.

Ein automatisierter Vergleich mit den zuvor gesicherten Instanzobjekten bestätigte Host, Aktivierung, Ports und bisherige native Einstellungen. Die abschließende Assertion meldete: `All production assertions passed; both device identities remain distinct.`

Ein weiterer Dauerlauf bis 13:36 Uhr zeigte unverändert beide Prozesse, fortlaufend frische getrennte VPV-Werte und keine neuen VE.Direct-Warnungen oder Fehler seit dem kontrollierten Restart.

## Dateiintegrität

Die SHA-256-Hashes der produktiv installierten Dateien stimmen exakt mit dem lokalen Release-Tag überein:

| Datei | SHA-256 |
|---|---|
| `main.js` | `bc9590146546748579e807786510d9fe1420946bde57dbf5516d15083cec70c4` |
| `lib/veDirect/veDirectParser.js` | `c2e8a47895ef0768c2564d2293dda9a4cf40fb5cb0b3c22f38a6f01c55c8fbd2` |
| `lib/veDirect/fields.js` | `3946e47a35887f07881c8aec7bb2d31c5ec8414b6031bc9bb06350e166dd33f9` |
| `lib/veDirectCom.js` | `5e10438890b7bc1f519021e204ec6e8cb9594906de79a287300e3f9447106a84` |
| `package.json` | `82a79fdcce2278e5a312aaa7698bb3d9bdb2f3fda739837712d632f642590501` |

## Einordnung der Altlogs

Während des Upgrades erschienen um 13:23:56 Uhr `SerialPort.close is not a function` und SIGKILL-Meldungen. Sie betreffen nach PID und Zeitstempel ausschließlich die alten 0.1.2-Prozesse 513 und 526. Die neuen 0.4.0-Prozesse starteten erst danach. Der separate kontrollierte Restart der neuen Prozesse um 13:28 Uhr war ohne diese Fehler.

## Weiterhin gültige Grenze

Der produktive Fork bleibt read-only. Es werden keine HEX-`Get`/`Set`-Kommandos, beschreibbaren States oder Steuerfunktionen bereitgestellt. Historische State-Werte wurden nicht rückwirkend verändert.
