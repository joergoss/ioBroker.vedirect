# Admin 5 / jsonConfig (#9)

Stand: 2026-11-21, Entwicklungsbranch `feat/admin5-jsonconfig`.

## Migration

Die bisherige Materialize-/jQuery-Konfiguration wurde vollständig durch `admin/jsonConfig.json` ersetzt. `common.adminUI.config` ist `json`. Die alten Dateien `index_m.html`, `style.css`, `words.js`, `admin.d.ts` und `tsconfig.json` werden nicht mehr benötigt. Die Übersetzungen verwenden das bevorzugte Kurzformat `admin/i18n/<lang>.json` und werden direkt von Admin 5 gelesen. Die Konvertierung aus dem langen Format erfolgte mit `npm run translate convert`; alle elf Kataloge blieben als JSON-Werte nachweislich unverändert.

Alle bisherigen Config-Keys und Defaults bleiben unverändert, einschließlich des legacy Schlüssels `byUSB`. Display-only-Einträge beginnen mit `_` und werden nicht in `native` gespeichert.

## Bedingte Felder und Validierung

- `byTCPIP=false` zeigt den lokalen Serialport; TCP-Felder sind ausgeblendet und ihre Werte bleiben dennoch erhalten.
- `byTCPIP=true` zeigt Hostname/IP-Adresse und Port. Der USB-Pfad ist dann nicht erforderlich.
- `tcpPort: 0` bleibt als Default im seriellen Modus gültig; die Bereichsprüfung 1–65535 gilt nur bei aktiviertem TCP.
- Hostnamen und IPv4/IPv6 werden strukturell geprüft, einschließlich komprimierter und vollständig ausgeschriebener IPv4-eingebetteter Adressen sowie Hostnamen mit abschließendem Punkt. IPv4-Oktette mit führenden Nullen werden innerhalb von IPv4-eingebetteten IPv6-Adressen abgelehnt; numerische Hostnamen außerhalb von IPv6 folgen unverändert dem gemeinsamen Hostnamen-Fallback. Scope-IDs bestehen aus ASCII-Buchstaben/Ziffern und werden getrennt von der IPv6-Adresse validiert, damit UI und Laufzeit nicht von plattformabhängigen `net.isIP()`-Zonenregeln abweichen. URL-/Pfad-/Whitespace-Formen werden abgelehnt. Eine gemeinsame Tabelle und eine zusätzliche Kombinationsmatrix gegen Node’s native IPv6-Grammatik sichern die Parität.
- `expireTime` und `messageBuffer` erlauben null beziehungsweise leere Alt-Werte.
- `currentLimitMax` und `currentLimitRefreshSeconds` erscheinen nur mit aktivierter Stromsteuerung. Erst dann gelten positiver Strom von höchstens 6553,4 A in exakten 0,1-A-Schritten und ein ganzzahliges Refresh-Intervall von 5–50 Sekunden. Deaktivierte Werte sind auch im Adapter inert und verhindern keinen Start.
- `validatorNoSaveOnError` verhindert das Speichern ungültiger Eingaben bereits in Admin. Die unabhängige Laufzeitvalidierung bleibt unverändert.

Sicherheitshinweise verwenden `infoBox` mit `closeable: false`, sind nicht schließbar und bleiben sichtbar. Admin 7.6.20 bezeichnet die Eigenschaft in seinem Schema fälschlich als `closable`; der Schema-Test transformiert ausschließlich eine Kopie für diese bekannte Mindestschema-Inkompatibilität. Die Produktivkonfiguration verwendet die tatsächliche Renderer-Eigenschaft `closeable`. Der Browser-Test bestätigt zusätzlich am tatsächlichen Markup, dass ausschließlich das Warn-SVG und kein Schließen-/Visibility-SVG vorhanden ist. Neue Validator-Texte sind in allen zehn Sprachen vorhanden.

## Tests

`adminJsonConfig.test.js` prüft gegen lokal eingecheckte Schemas für Admin 7.6.20 und das aktuelle Format, native Keys/Defaults, responsive Größen, Entfernen der Legacy-Dateien, Sichtbarkeit und Validatoren sowie alle angezeigten Übersetzungen. Dadurch ist die Suite offline und unabhängig von einem veränderlichen `master`-Schema.

Der echte Browser-Test läuft über:

```sh
npm run test:admin
```

Dabei richtet `test:admin:setup` mit transientem `npx @iobroker/dev-server` ein isoliertes Profil unter `.dev-server/` ein. Vor jedem Lauf überträgt `test:admin:upload` die aktuelle Config erneut, damit niemals ein veraltetes Schema getestet wird. Verwendet werden die deklarierten Mindestversionen Admin 7.6.20 und js-controller 6.0.11. Der Testrunner startet den js-controller anschließend direkt: Der bereits loopback-gebundene Admin ist ausschließlich unter `http://127.0.0.1:20426` erreichbar; der dev-server-Proxy auf Port 8081 wird nicht gestartet. Die zugehörigen States-/Objects-Endpunkte auf 24426/26426 werden ebenfalls vor und nach dem Lauf auf Freigabe geprüft. Der VE.Direct-Adapter selbst wird nicht gestartet und benötigt daher keinen Serialport. `playwright-core` steuert das bereits installierte Chrome ohne Playwright-Runner oder Browser-Download.

Abgedeckt sind:

- initiale Defaults ohne ungewolltes Speichern,
- Umschalten seriell/TCP und Control-Opt-ins,
- ungültige Hosts, malformed IPv6, nicht kanonische IPv4-Oktette und ungültige Scope-IDs,
- IPv4, komprimierte/vollständige IPv4-eingebettete und scoped IPv6,
- nicht schließbare TCP- und Control-Sicherheitshinweise,
- Ports, Stromwerte und Refresh-Intervalle einschließlich ganzzahliger Laufzeitgrenzen,
- ungültige Stromwerte nach Opt-out und erneute Aktivierung,
- Speichern und Reload nativer Werte,
- Erhalt versteckter Werte ohne unbeabsichtigte Änderungen,
- keine Browser-`pageerror`-Ereignisse.

Der Workflow `.github/workflows/test-and-release.yml` führt diesen Test als separaten `admin-e2e`-Job auf Ubuntu/Node 24 aus. Der Release-`before_commit`-Hook führt ihn ebenfalls aus. Optional kann mit `CHROME_PATH` ein Browserbinary oder mit `ADMIN_E2E_URL` ein bereits laufender Admin verwendet werden. `CHROME_CHANNEL` überschreibt den Standardkanal `chrome`.

`ADMIN_E2E_URL` darf ausschließlich auf eine wegwerfbare Testinstanz zeigen, weil der Test die Konfiguration von `vedirect.0` verändert. Die Aufräumroutine verfolgt bereits den Browser-Launch als Promise und schließt Browser und Controller auch nach `SIGINT`/`SIGTERM` idempotent. POSIX-Prozessgruppen werden auch nach Leader-Exit behandelt. Unter Windows wird `taskkill /T /F` nur für einen noch laufenden Leader ausgeführt; Spawnfehler, Timeout und Exitstatus werden geprüft. Ist der Windows-Leader bereits beendet, wird bewusst keine möglicherweise wiederverwendete PID attackiert: Verbliebene Nachkommen ohne eigenen Root-Baum sind eine Plattformgrenze und werden durch die abschließende Prüfung der owned Admin-/DB-Endpunkte als Testfehler gemeldet statt still akzeptiert. Cleanup-Fehler führen auch im Signalpfad zu einem Fehler-Exitcode.

Das isolierte dev-server-Profil enthält einen eigenen Abhängigkeitsbaum mit den ausdrücklich gewählten Mindestversionen und wird weder in das Produktivpaket noch in die Produktivkonfiguration übernommen. Es darf nicht als Vorlage für eine produktive Installation alter Versionen verstanden werden.
