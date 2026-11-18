# VE.Direct Performancevergleich 2026-11-18

## Messaufbau

Auf pi4/ARM64/Node 24 liefen beide produktiven SmartSolar-Instanzen mit getrennten seriellen Ports. Pro Szenario wurden 30 Sekunden gemessen:

- CPU-Jiffies der Adapterprozesse, umgerechnet in Prozent der Messzeit,
- RSS des Prozesses,
- `eventLoopLag` des js-controllers,
- tatsächliche Redis-`set`-Operationen mit Präfix `io.vedirect.0.` beziehungsweise `io.vedirect.1.`.

`get` und `publish` wurden nicht als State-Writes gezählt. Jede Konfiguration wurde anschließend kontrolliert neu gestartet. Nach allen Messungen wurden die ursprünglichen Werte `messageBuffer=0` und `expireTime=""` wiederhergestellt.

Die Ergebnisse sind kurze reale Stichproben bei geringer PV-Leistung, keine Langzeitgarantie. Prozessneustarts verändern den Speicherstand; deshalb sind CPU- und State-Writes besser vergleichbar als RSS.

## Ergebnisse

| `messageBuffer` | `expireTime` | Instanz | CPU | State-Writes in 30 s | Writes/s | Event-Loop-Lag |
|---:|---:|---|---:|---:|---:|---:|
| 0 | 0 | vedirect.0 | 2.70 % | 21 | 0.700 | 1 ms |
| 0 | 0 | vedirect.1 | 2.40 % | 4 | 0.133 | 1 ms |
| 30 s | 0 | vedirect.0 | 2.13 % | 0 | 0.000 | 1 ms |
| 30 s | 0 | vedirect.1 | 1.67 % | 1 | 0.033 | 2 ms |
| 60 s | 0 | vedirect.0 | 1.50 % | 0 | 0.000 | 1 ms |
| 60 s | 0 | vedirect.1 | 1.50 % | 0 | 0.000 | 1 ms |
| 30 s | 120 s | vedirect.0 | 2.10 % | 8 | 0.267 | 1 ms |
| 30 s | 120 s | vedirect.1 | 2.13 % | 8 | 0.267 | 1 ms |
| 0 | 120 s | vedirect.0 | 6.50 % | 240 | 7.999 | 1 ms |
| 0 | 120 s | vedirect.1 | 6.93 % | 240 | 7.999 | 2 ms |

RSS lag je nach Szenario/Neustart zwischen etwa 129 und 166 MB. Die kurzen Stichproben liefern dafür keine belastbare Sparwirkung.

## Interpretation

1. **Sampling funktioniert quantitativ:** 30 s und 60 s reduzieren State-Writes und CPU deutlich, ohne den Event-Loop-Lag nennenswert zu erhöhen.
2. **Changed-Optimierung funktioniert:** Ohne positive TTL werden unveränderte Werte nicht ständig erneut geschrieben.
3. **TTL-Erneuerung ist der größte gemessene Kostentreiber:** Ohne Sampling und mit 120 s Ablaufzeit entstanden 240 State-Writes pro Instanz und etwa 6,5–6,9 % CPU. Mit 30 s Sampling waren es nur noch 8 Writes bei etwa 2,1 %.
4. `expireTime` ist eine **Ablaufzeit**, kein Poll- oder Samplingintervall. Sie muss bei Verwendung größer als das Samplingintervall sein, damit Werte nicht zwischen den Publikationen ablaufen.
5. Der Parser und die Verbindungsüberwachung laufen weiterhin pro gültigem Block. Sampling reduziert die Datenbankarbeit, nicht die Protokollprüfung.

## Praktische Konfiguration

- Wenn State-/Redis-Last ein Thema ist, ist `messageBuffer=30` eine sinnvolle Ausgangseinstellung; 60 s kann bei weniger zeitkritischen Dashboards noch weiter reduzieren.
- Eine positive `expireTime` sollte nur verwendet werden, wenn veraltete Werte tatsächlich automatisch ablaufen sollen. Sie darf nicht mit dem Samplingintervall verwechselt werden.
- Bei 30 s Sampling muss die TTL deutlich darüber liegen, beispielsweise 120 s. Ohne zwingenden Ablaufgrund ist `expireTime=0` beziehungsweise leer die günstigere Einstellung.

## Reproduktion

Das Messprogramm verändert keine Konfiguration und keine Geräteparameter:

```bash
NODE_PATH=/opt/iobroker/node_modules \
BENCHMARK_SECONDS=30 \
BENCHMARK_BUFFER=30 \
BENCHMARK_EXPIRE=0 \
node /tmp/vedirect-benchmark.js
```

Es liest Prozessmetriken und Redis-State-Writes. Die Konfigurationsszenarien müssen separat gesetzt und danach zurückgesetzt werden. Die Ausführung erfolgte mit `tools/vedirect-benchmark.js`; drei Helper-Tests prüfen Befehlsfilter, `/proc`-Parsing und Zeitgrenzen.
