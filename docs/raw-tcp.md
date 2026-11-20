# Raw-TCP-Serial-Server

Stand: 2026-11-19, Entwicklungsbranch `feat/raw-tcp`.

## Zweck und Umfang

Der optionale Raw-TCP-Transport unterstützt den in Upstream-Issue #541 beschriebenen Anwendungsfall: Ein ESP32 oder ein vergleichbarer Serial-Server stellt den unveränderten VE.Direct-Bytestream eines SmartSolar-Ladereglers über einen TCP-Port bereit. Der Adapter verbindet sich direkt mit Hostname/IP-Adresse und Port, ohne lokalen SerialPort und ohne zusätzliche Runtime-Abhängigkeit.

Unterstützt wird ausschließlich ein **direkter TCP-Bytestream**. Nicht unterstützt werden Telnet-/RFC2217-Aushandlung, WebSockets, HTTP, MQTT, TLS oder andere Protokollkapselungen. Die serielle Gegenseite muss weiterhin für VE.Direct mit **19200 Baud, 8N1** konfiguriert sein; diese Parameter gehören zur Serial-Bridge und werden nicht über TCP ausgehandelt.

## Konfiguration

- `byTCPIP=false` ist der kompatible Standard und verwendet weiterhin `USBDevice`.
- `byTCPIP=true` aktiviert TCP. In diesem Modus ist kein lokaler `USBDevice`-Pfad erforderlich.
- `tcpHost` enthält ausschließlich einen Hostnamen oder eine IP-Adresse, ohne URL-Scheme oder Pfad.
- `tcpPort` ist ein Integer von 1 bis 65535. Es gibt keinen angenommenen Standardport; der tatsächlich am Serial-Server konfigurierte Port ist einzutragen.
- Das historische `byUSB` bleibt aus Kompatibilitätsgründen erhalten. Die Transportauswahl erfolgt ausschließlich über das ausdrückliche TCP-Opt-in `byTCPIP`.

Der Serial-Server muss den VE.Direct-Stream exklusiv und bytegetreu weiterreichen. Es darf kein zweiter Adapterprozess oder Serial Monitor dieselbe serielle Verbindung beziehungsweise dieselbe Single-Client-TCP-Session verwenden.

## Sicherheit

Raw TCP bietet weder Verschlüsselung noch Authentifizierung. Der Transport ist deshalb nur für ein vertrauenswürdiges lokales Netz oder einen separat abgesicherten Tunnel vorgesehen und darf nicht ungeschützt ins Internet freigegeben werden.

Der Adapter bleibt standardmäßig read-only. Auch über TCP gelten unverändert die feste HEX-Registerwhitelist, die getrennten Opt-ins und sämtliche Grenzen für Charger on/off und dynamisches Stromlimit. Da ein Netzwerkangreifer bei ungeschütztem TCP grundsätzlich Daten lesen oder verändern könnte, sollten Steuerfunktionen nur in einer entsprechend abgesicherten Umgebung aktiviert werden.

## Parser- und Lifecycle-Semantik

TCP ändert ausschließlich den Transport, nicht das Protokoll:

- Beliebige TCP-Segmentierungen und binäre Checksumbytes werden durch denselben atomaren VE.Direct-Parser verarbeitet.
- `info.connection=true` setzt weiterhin frische, checksumgültige Blöcke voraus; ein erfolgreicher TCP-Connect allein genügt nicht.
- Open, Write und Close besitzen feste Deadlines. Remote-Close und Socketfehler invalidieren die betroffene Session.
- Bei Datenstopp oder Disconnect schließt der Watchdog die Verbindung kontrolliert und versucht nach dem bestehenden Cooldown einen Reconnect.
- Puffer und TTL werden nicht über Verbindungsgrenzen hinweg fortgesetzt.
- HEX-Get/Set verwenden exakte Response-Zuordnung, Set-Echo und Get-Readback. Nach Timeout oder ambivalentem Write-/Drain-Fehler gibt es kein blindes Set-Retry.

Verbindungsfehler wie `ECONNREFUSED`, DNS-Fehler und Timeouts bleiben sichtbar. Sie erzeugen keine Ersatzwerte, kein `NaN` und keine stillen Teil-Parses.

## Read-only-Diagnoseprogramm (#8)

Mit dem Diagnoseprogramm lässt sich ein Serial-Server prüfen, ohne eine ioBroker-Instanz zu starten oder deren Konfiguration zu ändern:

```sh
node tools/raw-tcp-probe.js 192.168.1.50 1234 12
```

Die ersten beiden Argumente sind Hostname/IP-Adresse und Port; das optionale dritte Argument ist die Messdauer in ganzen Sekunden (1–120, Standard 12). Das Programm öffnet genau eine begrenzte TCP-Verbindung und erzeugt keine HEX-Gets/Sets, Steuerbefehle oder Telnet-Aushandlung. Es verarbeitet den Stream mit dem produktiven Parser und gibt JSON aus, unter anderem:

- `validFrameCount` und `lastValidFrameAt` für tatsächlich checksumgültige Blöcke sowie `lastFrame` und `lastFrameAt` für den letzten Block mit decodierten bekannten Feldern,
- Parserzähler für Checksum-, Frame- und HEX-Fehler,
- Verbindungsfehler und einen vorzeitigen Remote-Close,
- `bytesWritten` und `readOnlyVerified` als Nachweis, dass kein einziges Byte zum Server gesendet wurde,
- `ok` sowie maschinenlesbare `reasons` für eine automatisierte Auswertung.

Exit-Code 0 bedeutet mindestens einen gültigen Block ohne erkannte Verbindungs-/Parserfehler und nachgewiesenermaßen null geschriebene Bytes. Exit-Code 1 kennzeichnet einen fehlgeschlagenen oder fehlerhaften Diagnoselauf, Exit-Code 2 eine ungültige Kommandozeile. `--help` zeigt die Kurzhilfe. Die Messung darf nur auf einem bereits freigegebenen Single-Client-Endpunkt erfolgen und ersetzt keine Freigabe durch den Benutzer.

## Validierungsgrenze und reale Victron-Probe

Die automatisierte Suite verwendet echte TCP-Server und Sockets auf `127.0.0.1` mit dem produktiven Parser, Transport und HEX-Client. Zusätzliche adversariale Gegenproben mit kontrolliert verzögertem DNS bestätigen:

- Close und Adapter-Unload zerstören einen pending TCP-Socket vor ihrem Abschluss; eine spätere DNS-Auflösung erzeugt keinen Late-Connect mehr.
- Remote-Close invalidiert sofort Generation, Samples und wartende Frame-Batches. Nach Freigabe blockierter Datenbankoperationen werden keine alten States oder TTLs mehr publiziert; der HEX-Close-Handler bleibt verkettet.
- Open-Fehler werden einmal gemeldet, wiederholte Runtime-Fehler bleiben weiterhin einzeln sichtbar.
- Das sofortige Open-Cancel ist eine ausdrückliche TCP-Fähigkeit. Ein echter `SerialPortStream` mit verzögertem Binding-Open verwendet weiterhin den kontrollierten Late-Open-Cleanup ohne falschen `Port is not open`-Fehler.

Am 2026-11-19 wurde zusätzlich eine reale Victron-Probe auf pi4/ARM64/Node 24.22.3 durchgeführt. Dazu wurde ausschließlich `vedirect.0` kontrolliert gestoppt und sein physikalischer Port `/dev/ttyUSB-VE-1` mit SerialPort 12 über eine temporäre Loopback-TCP-Bridge mit dem Release-Kandidaten verbunden. `vedirect.1` lief unverändert weiter. Die Bridge ließ nach vollständiger Frame-Dekodierung ausschließlich HEX-Get-Kommandos zur Hardware durch; jedes andere Kommando hätte die Verbindung vor einer Weiterleitung abgebrochen.

| Nachweis | Ergebnis |
|---|---|
| Reale TCP-Sessions | 2, einschließlich vollständigem Neuaufbau |
| Gerät | SmartSolar MPPT 100/50, Seriennummer `HQ2128GXFZP` |
| Frische TEXT-Werte | In beiden Sessions gültig; unter anderem `V=12.57 V`, `VPV=0.06/0.07 V` |
| HEX-Zugriffe | 4 Gets, **0 Sets** |
| Control-Readbacks | Charger ein, `standalone`, persistentes Maximum 50 A; nach Reconnect weiterhin `standalone` |
| Produktivwiederherstellung | Bridge beendet, `vedirect.0` mit 0.5.1 direkt seriell neu gestartet, Stopp zuvor Code 11 |
| Konfiguration | `native` bytegleich unverändert, weiterhin `byTCPIP=false` und `/dev/ttyUSB-VE-1` |
| Beide Produktivinstanzen | Frische getrennte Werte, beide Supervisoren inaktiv, beide Network Modes `standalone` |

Damit ist der Transport mit einem realen Victron-Datenstrom und echten TCP-Reconnects validiert. Die konkrete ESP32-Firmware aus Issue #541 und der Browser-E2E-Test des Admin-Dialogs bleiben weiterhin ungetestet; daraus wird keine universelle Kompatibilität mit jeder Serial-Server-Firmware abgeleitet.
