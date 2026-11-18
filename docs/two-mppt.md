# Zwei Victron-MPPTs mit ioBroker.vedirect

## Aktueller Produktivaufbau

Auf dem pi4 (ioBroker-Host `iobroker`) existieren zwei aktivierte Instanzen mit jeweils eigenem SmartSolar MPPT 100/50:

| Instanz | Konfigurierter serieller Pfad | Reale Felder |
|---|---|---|
| `vedirect.0` | `/dev/ttyUSB-VE-1` | V, VPV, I, PPV, CS, MPPT, ERR, OR, H19–H23, HSDS, PID, SER#, FW |
| `vedirect.1` | `/dev/ttyUSB-VE-2` | Dieselben Feldgruppen, eigene unabhängige Werte |

Jeder MPPT benötigt eine eigene VE.Direct-Verbindung und einen eigenen Serialport. Derselbe Port darf nicht gleichzeitig von zwei Programmen oder Instanzen verwendet werden. Für dauerhafte Zuordnung sind `/dev/serial/by-id/...`-Pfade oder dokumentierte statische Aliase empfohlen.

## Was der Fork mit beiden MPPTs kann

- Beide Geräte gleichzeitig und instanzgetrennt auslesen.
- Spannung, Strom, Panelspannung und Panelleistung verarbeiten.
- Betriebszustand, Trackerstatus, Fehler und Abschaltgründe decodieren.
- Historische Tages-/Gesamterträge und maximale Leistung lesen.
- Produkte, Seriennummern und Firmware unterscheiden.
- Checksummen, Multiblock, HEX-Unterbrechungen und Recovery pro Instanz verarbeiten.
- Ports, Watchdogs, Samples und Reconnects vollständig getrennt halten.

Der Adapter aggregiert oder steuert die beiden Geräte nicht automatisch gemeinsam; Berechnungen/Regelungen über beide MPPTs können in ioBroker-Skripten auf den getrennten States aufsetzen.

## Read-only-Standard und optionaler HEX-Zugriff

Der Adapter bleibt standardmäßig read-only. Seit dem HEX-Ausbau kann pro Instanz eine feste Registerwhitelist gelesen werden; Charger-on/off und dynamisches Ladestromlimit sind separate Opt-ins mit Read-after-Write. Siehe [docs/hex-control.md](hex-control.md).

Nicht freigeschaltet sind allgemeine Rohregister, Remote-Spannungsschreiben, BMS-/Slave-Modi, persistente Batterieeinstellungen und Load-/Relaissteuerung.

## Grenzen der Steuerung

| Funktion | Beispielregister | Wichtige Einschränkung |
|---|---|---|
| Dynamisches Ladestromlimit | `0x2015` | Optional implementiert; External-Control-Modus `0x200E`, Capability-Gate, Refresh und Read-after-Write erforderlich |
| Charger Ein/Aus | `0x0200` | Optional implementiert; Software-Schalter, keine elektrische Trennung |
| Ladespannungs-Sollwert | `0x2001` | Nur lesbar; kein Spannungsschreibsupport |
| Persistentes maximales Batteriestromlimit | `0xEDF0` | Nur lesbar; nicht für dynamische Schleifen |
| Load-Ausgang/Relais | modellabhängig | Keine Steuerung; kein physischer Load-/Relaisausgang am SmartSolar 100/50 belegt |

Ein Ausbleiben der External-Control-Daten führt nach etwa einer Minute zu Stand-alone und dem persistenten Maximalstrom, nicht zu einer ausfallsicheren Abschaltung.

### Sicherheitsanforderungen für etwaigen Schreibsupport

- Standardmäßig deaktiviert und auf eine explizite Whitelist begrenzt.
- Response-/Fehlerdecodierung und Read-after-Write.
- Kein paralleler Zugriff durch ein zweites Programm auf denselben Port.
- Keine kontinuierlichen Schreibschleifen auf nichtflüchtige Batterieeinstellungen.
- Berücksichtigung möglicher TEXT-Pausen nach HEX-Kommunikation.
- Keine allgemeinen Restore-/Clear-History-/Restart-Kommandos.
- Keine Load-Steuerung ohne Entladungsschutz und passende Hardware.

## Quellen

- [VE.Direct Protocol 3.34](https://www.victronenergy.com/upload/documents/VE.Direct-Protocol-3.34.pdf)
- [VE.Direct Protocol FAQ](https://www.victronenergy.com/live/vedirect_protocol:faq)
- [BlueSolar/SmartSolar HEX Protocol](https://www.victronenergy.com/upload/documents/BlueSolar-HEX-protocol.pdf)
