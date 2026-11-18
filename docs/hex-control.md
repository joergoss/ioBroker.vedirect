# Optionaler VE.Direct-HEX-Zugriff

## Sicherheitsstandard

Der Adapter bleibt standardmäßig read-only. Alle HEX-Funktionen sind einzeln opt-in. Mess-States werden nicht beschreibbar; Steuerungen liegen ausschließlich unter `control.*`.

Es gibt keine Oberfläche für beliebige Register oder Roh-HEX-Befehle. BMS-/Slave-Modi, Remote-Spannungsschreiben, persistente Batterieeinstellungen, Restore-/Restart-/Clear-History-Funktionen sowie Load-/Relaissteuerung sind nicht freigeschaltet.

## Get-only

`hexReadEnabled=true` aktiviert nach frischen gültigen TEXT-Daten Abfragen dieser festen Registerwhitelist:

| Register | Inhalt |
|---|---|
| `0x0140` | Capabilities einschließlich External-Control-Bit 15 |
| `0x0200` | Device Mode / Charger-Softschalter |
| `0x0201` | Tatsächlicher Device State |
| `0x0202` | Remote-Control-Maske |
| `0x200E` | Network Mode |
| `0x2015` | Dynamisches Charge Current Limit |
| `0xEDF0` | Persistentes Battery Maximum Current, nur lesbar |
| `0x2001` | Charge Voltage Setpoint, nur lesbar |

Jede Antwort benötigt gültige Framing-/ASCII-/Längenregeln und die HEX-Checksumme modulo `0x55`. Command, Register-ID, Flags und exakte Wertebreite werden geprüft. Ein nicht unterstütztes Register erzeugt keinen Ersatzwert; der Fehler wird in `control.lastError` sichtbar und übrige unabhängige Gets werden fortgesetzt.

Für SmartSolar-Firmware ab 1.53 wird TEXT nicht wegen HEX pausiert. Die vorhandene TEXT-Liveness bleibt deshalb maßgeblich.

## Steuer-Opt-ins

| Einstellung | Standard | Bedeutung |
|---|---:|---|
| `hexReadEnabled` | `false` | Nur die oben genannten HEX-Gets |
| `chargerControlEnabled` | `false` | `control.chargerOn` wird beschreibbar |
| `currentLimitControlEnabled` | `false` | Stromlimit und lokaler Supervisor werden beschreibbar |
| `currentLimitMax` | `0` | Zusätzliche Adapter-Sicherheitsobergrenze in A; für Stromsteuerung zwingend größer 0 |
| `currentLimitRefreshSeconds` | `20` | Refresh-Intervall; bei aktivierter Stromsteuerung zulässig 5–50 Sekunden |

Control-Writes werden nur bei offener Verbindung und frischen gültigen TEXT-Daten angenommen. Die Runtime prüft die Freigaben zusätzlich zur Admin-UI.

## States

| State | Schreibzugriff | Semantik |
|---|---|---|
| `control.capabilities` | nie | Geprüfte Roh-Capability-Maske |
| `control.externalControlSupported` | nie | Aus Capability-Bit 15 abgeleitet |
| `control.chargerOn` | mit Charger-Opt-in | Gelesener Charger-Softschalter; kein Nachweis aktuell fließender PV-Leistung |
| `control.deviceState` | nie | Rohbetriebszustand des Geräts |
| `control.remoteControlUsed` | nie | Remote-Control-Maske |
| `control.networkMode` | nie | `standalone`, `slave`, `external` oder `bms` |
| `control.maximumBatteryCurrent` | nie | Persistente Stromobergrenze `0xEDF0` |
| `control.chargeCurrentLimit` | mit Strom-Opt-in | Nach Set tatsächlich zurückgelesenes dynamisches Limit in A |
| `control.currentLimitActive` | mit Strom-Opt-in | Zustand des **lokalen Adapter-Supervisors**, nicht eine Garantie für den Gerätezustand |
| `control.chargeVoltageSetpoint` | nie | Gelesener Remote-Spannungssollwert |
| `control.lastError` | nie | Letzter Register-, Transport- oder Validierungsfehler |

## Set und Read-after-Write

Ein Set besteht aus zwei getrennten Wire-Phasen:

1. Set mit exakter Wertekodierung und Prüfung der Set-Antwort einschließlich Value-Echo.
2. Get desselben Registers und strikte Dekodierung des tatsächlich gelesenen Werts.

Erst danach wird der Control-State mit `ack=true` veröffentlicht. Bei Fehler, falschem Echo oder Readback-Mismatch wird der angefragte Sollwert nicht als erfolgreich dargestellt.

Pro Instanz existiert höchstens eine aktive HEX-Transaktion und eine begrenzte Warteschlange. Die Adapter-Stromsteuerung lässt ebenfalls nur eine ausstehende Änderung zu. Response-Timeout oder ambivalenter Write-/Drain-Fehler invalidieren die Serialsession; es gibt kein blindes Set-Retry. Der Port wird geschlossen, damit späte Antworten keiner neuen Operation zugeordnet werden.

## Charger Ein/Aus

`control.chargerOn` akzeptiert ausschließlich echte Booleans. Kodiert wird `1` für Ein und `4` für Aus; gelesene Alt-Firmwarewerte `0` für Aus werden korrekt behandelt.

Dies ist ein Software-Schalter, keine elektrische Trennung und kein Load-/Relaisausgang.

## Dynamisches Ladestromlimit

Ein beschreibbarer Wert muss numerisch, endlich, innerhalb `0..currentLimitMax` und exakt in 0,1-A-Schritten darstellbar sein. Feinere Werte werden abgelehnt statt gerundet.

Vor dem ersten Set muss das Gerät External-Control-Capability besitzen. Der Adapter schreibt und verifiziert:

- Network Mode External Control (`0x200E = 0x05`),
- Charge Current Limit (`0x2015`).

Anschließend startet der lokale Supervisor und erneuert beide Werte samt Readbacks im konfigurierten Intervall. Das wirksame Geräte-Limit ist zusätzlich durch das persistente `0xEDF0` begrenzt.

`control.currentLimitActive=false` stoppt den lokalen Timer und versucht Network Mode Standalone (`0`) mit Readback. Schlägt dieser Zugriff fehl, bleibt der lokale Supervisor dennoch aus; `control.lastError` zeigt den Fehler und das Gerät kann bis zu seinem Protokolltimeout weiter extern gesteuert sein.

Beim Adapter-Unload werden keine zusätzlichen Geräte-Sets gesendet. Nach einem Neustart aktiviert sich der Supervisor nicht automatisch; ein vorheriger Wert muss erneut bestätigt werden.

### Fallback ist keine Abschaltung

External Control fällt nach etwa einer Minute ohne Daten auf Stand-alone zurück. Dabei gilt wieder das persistente Maximum `0xEDF0`; der Strom kann ansteigen. Dies ist weder ein Fail-safe-Off noch ein Ersatz für BMS und physische Schutzsysteme. `0x2015=0` wird nicht als verlässliches Charger-Off interpretiert.

## Read-only-Diagnoseprogramm

Nach kontrolliertem Stopp der jeweiligen Adapterinstanz kann das mitgelieferte Programm ausschließlich HEX-Gets an einem freien Port ausführen:

```bash
node tools/hex-get-probe.js /dev/ttyUSB-VE-1
```

Es enthält keine Set-Operation. Vorher muss sichergestellt sein, dass kein anderer Prozess den Port geöffnet hat. Anschließend wird die ursprüngliche Instanz wieder gestartet und deren frische TEXT-Werte geprüft.

## Quellen

- [BlueSolar/SmartSolar HEX Protocol Rev. 18](https://www.victronenergy.com/upload/documents/BlueSolar-HEX-protocol.pdf)
- [VE.Direct Protocol 3.34](https://www.victronenergy.com/upload/documents/VE.Direct-Protocol-3.34.pdf)
- [VE.Direct FAQ](https://www.victronenergy.com/live/vedirect_protocol:faq)
- [SmartSolar MPPT 100/30 & 100/50 Manual](https://www.victronenergy.com/upload/documents/Manual_SmartSolar_MPPT_100-30__100-50/29694-MPPT_solar_charger_manual-pdf-en.pdf)
