# Read-only-Laufzeitdiagnostik (#10)

Stand: 2026-11-21, Entwicklungsbranch `feat/runtime-diagnostics`.

## Ziel und Grenzen

Sechs zusätzliche States unter `info` machen Transport-, Liveness- und Parserprobleme ohne Loganalyse sichtbar. Alle Diagnosestates sind `read: true`, `write: false`, werden mit `ack: true` veröffentlicht und besitzen keine TTL-Erneuerung. Es werden keine Netzwerkadressen, Hostnamen, Serialport-Pfade oder Zugangsdaten in diesen States gespeichert. Die Diagnostik führt keine neuen HEX-Kommandos oder sonstigen Geräte-Schreibzugriffe ein.

Die Objektnamen sind in allen elf unterstützten Sprachen vorhanden. Bestehende State-IDs bleiben unverändert.

## States und Semantik

| State | Typ / Rolle | Bedeutung |
|---|---|---|
| `info.transport` | string / `text` | Tatsächlich konfigurierter Transport: `serial` oder `tcp`. Kein Hostname, keine IP-Adresse und kein Serialport-Pfad. |
| `info.lastValidFrameAt` | number / `value.time` | Unix-Zeitstempel in Millisekunden des letzten checksumgültigen TEXT-Frames. `0` bedeutet seit Adapterstart noch kein gültiger Frame. |
| `info.reconnectCount` | number / `value` | Erfolgreiche Opens **nach** dem ersten erfolgreichen Open. Der initiale Open und fehlgeschlagene Versuche zählen nicht. |
| `info.checksumErrors` | number / `value` | Kumulativer Parserzähler `checksumErrors` für verworfene TEXT-Checksummen. |
| `info.parserErrors` | number / `value` | Summe der kumulativen Parserzähler `invalidFrames + invalidHexMessages`. `invalidValues` wird nicht zusätzlich addiert, weil solche Werte bereits zum verworfenen Frame führen. Unbekannte Felder sind keine Parserfehler. |
| `info.lastTransportError` | string / `text` | Letzter tatsächlich beobachteter Transportfehler als sicherer Fehlercode oder maskierte Meldung. Der Wert bleibt nach einer erfolgreichen Wiederherstellung erhalten und wird erst durch den nächsten **geänderten** Fehler oder Adapterstart ersetzt. Der State-Zeitstempel markiert die letzte Wertänderung, nicht zwingend jedes erneute Auftreten desselben Fehlers. Geplante Closes erzeugen auch nach einem Close-Timeout keinen Fehler, solange der angeforderte Close später tatsächlich erfolgt; ein unerwarteter Close ohne vorherigen Fehler wird als solcher bezeichnet. |

Zähler und Fehler sind Laufzeitdiagnostik, keine persistenten Statistiken: Sie bleiben über Reconnects kumulativ und beginnen bei jedem Adapterstart wieder mit `0` beziehungsweise `''`. Diese Rücksetzung erfolgt unmittelbar nach der Objektmigration und damit auch bei ungültiger oder fehlender Transportkonfiguration vor einem möglichen frühen Startabbruch. `lastValidFrameAt` beginnt mit `0`. Der Zeitpunkt eines State-Zugriffs verändert keine Diagnosewerte.

## Schreibfrequenz

- Beim Start werden Transport und definierte Anfangswerte einmalig veröffentlicht.
- Danach werden ausschließlich geänderte Werte geschrieben. Eine instanzgebundene Latest-Value-Queue begrenzt jeden Diagnosestate auf höchstens einen aktiven Schreibvorgang und genau einen nachgezogenen neuen Wert. Langsame Datenbanken erzeugen daher auch bei Parser- oder Timestamp-Fehlerfluten keine unbegrenzten Promise-Backlogs.
- Der erste gültige Frame wird sofort mit seinem Zeitstempel veröffentlicht. Weitere Framezeitstempel werden höchstens alle **30 Sekunden** geschrieben, gemessen ab dem letzten tatsächlich erfolgreichen Schreibvorgang und nicht erst nach einem vollständig abgeschlossenen Drain; die bestehende sekundengenaue Liveness- und Reconnect-Logik verwendet weiterhin den ungedrosselten Speicherwert. Während eines langsamen Schreibvorgangs wird nur der neueste Folgezeitstempel vorgehalten, nicht jeder Zwischenwert.
- Bei Disconnect und Unload wird ein noch nicht veröffentlichter neuerer Framezeitstempel einmalig übernommen. Wiederholte Disconnects ohne neueren Frame erzeugen keinen Diagnosewrite. Der Flush wird nicht im Watchdog-Kritikpfad abgewartet und verändert nicht die Reihenfolge der `info.connection`-Transitionen. Nach einem Schreibfehler kann derselbe Zeitstempel erneut versucht werden; erst ein erfolgreicher Schreibvorgang gilt als bestätigt.
- Parserzähler werden nur durch tatsächliche Parser-Fehlerereignisse aktualisiert. Es gibt keinen sekündlichen Zählerpoll und keinen zusätzlichen Diagnosetimer.
- Reconnects werden erst nach erfolgreichem Open veröffentlicht. Fehlgeschlagene Versuche verändern den Zähler nicht. Sein Schreibvorgang wird nicht im Watchdog abgewartet und kann spätere Recovery-Zyklen nicht blockieren.

Die normale Messwertpublikation, Sampling und TTL bleiben unverändert. Diagnosewrites verwenden dieselben serialisierten State-Queues wie die übrigen Adapterstates.

## Fehlerdatenschutz

Native Fehlercodes wie `ECONNREFUSED`, `ETIMEDOUT` oder `ENOTTY` werden ohne zugehörige Adresse gespeichert. Andere Meldungen werden auf höchstens 512 Zeichen begrenzt und wie folgt maskiert:

- konfigurierter Hostname (case-insensitive) und Serialport-Pfad: `<target>`
- IPv4-/IPv6-Adressen einschließlich komprimierter, scoped und bracketed Formen: `<address>`
- URLs: `<url>`

IP-Kandidaten werden mit `net.isIP` geprüft. Eine No-Code-Meldung wird nur veröffentlicht, wenn die **vollständige resultierende Meldung** nach dem Maskieren einer strengen sicheren Vorlage entspricht oder die vollständige statische Meldung positiv als ziel- und pfadfrei bekannt ist. Ein einzelnes maskiertes Ziel autorisiert keine restliche unbekannte Meldung. Andernfalls erscheint konservativ nur der Fehlertyp. Diese Positivliste verhindert auch unbekannte Hostnamen mit oder ohne Port sowie unbekannte Serialpfade in States. Dadurch bleibt die Fehlerart erkennbar, ohne Netzwerk- oder Zugangsdaten preiszugeben. Scoped-IPv6-Verbindungen bleiben trotz struktureller Validierung vom Betriebssystem und Interface abhängig.

## Tests

Die Suite prüft:

- Objektmigration, Rollen, Defaults und alle elf Sprachen,
- serielle und TCP-Initialisierung ohne Zieladressen in States,
- initiale Opens versus erfolgreiche Reconnects und fehlgeschlagene Versuche,
- 30-Sekunden-Drosselung und Disconnect-Flush,
- reale Checksum-, malformed-Frame- und HEX-Overflow-Ereignisse mit kumulativen Zählern,
- Fehler-Maskierung und Erhalt des letzten Fehlers nach Recovery,
- sofortige Disconnect-Invalidierung, Unload und zwei unabhängige Instanzen,
- keine wiederholten Diagnosewrites bei unveränderten Werten.
