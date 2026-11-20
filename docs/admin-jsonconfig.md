# Admin 5 / jsonConfig (#9)

Stand: 2026-11-20, Entwicklungsbranch `feat/admin5-jsonconfig`.

## Migration

Die bisherige Materialize-/jQuery-Konfiguration wurde vollständig durch `admin/jsonConfig.json` ersetzt. `common.adminUI.config` ist `json`. Die alten Dateien `index_m.html`, `style.css`, `words.js`, `admin.d.ts` und `tsconfig.json` werden nicht mehr benötigt. Die Übersetzungen bleiben im bestehenden Format `admin/i18n/<lang>/translations.json` und werden direkt von Admin 5 gelesen.

Alle bisherigen Config-Keys und Defaults bleiben unverändert, einschließlich des legacy Schlüssels `byUSB`. Display-only-Einträge beginnen mit `_` und werden nicht in `native` gespeichert.

## Bedingte Felder und Validierung

- `byTCPIP=false` zeigt den lokalen Serialport; TCP-Felder sind ausgeblendet und ihre Werte bleiben dennoch erhalten.
- `byTCPIP=true` zeigt Hostname/IP-Adresse und Port. Der USB-Pfad ist dann nicht erforderlich.
- `tcpPort: 0` bleibt als Default im seriellen Modus gültig; die Bereichsprüfung 1–65535 gilt nur bei aktiviertem TCP.
- Hostnamen und IPv4/IPv6 werden geprüft, URL-/Pfad-/Whitespace-Formen abgelehnt. Die Laufzeitnormalisierung bleibt zusätzlich maßgeblich.
- `expireTime` und `messageBuffer` erlauben null beziehungsweise leere Alt-Werte.
- `currentLimitMax` und `currentLimitRefreshSeconds` erscheinen nur mit aktivierter Stromsteuerung. Erst dann gelten positiver Strom in exakten 0,1-A-Schritten und ein ganzzahliges Refresh-Intervall von 5–50 Sekunden.
- `validatorNoSaveOnError` verhindert das Speichern ungültiger Eingaben bereits in Admin. Die unabhängige Laufzeitvalidierung bleibt unverändert.

Sicherheitshinweise verwenden `infoBox` und sind nicht abschließbar. Neue Validator-Texte sind in allen zehn Sprachen vorhanden.

## Tests

`adminJsonConfig.test.js` prüft das offizielle Schema, native Keys/Defaults, responsive Größen, Entfernen der Legacy-Dateien, Sichtbarkeit und Validatoren sowie alle angezeigten Übersetzungen.

Der echte Browser-Test läuft über:

```sh
npm run test:admin
```

Dabei richtet `test:admin:setup` mit transientem `npx @iobroker/dev-server` ein isoliertes Profil unter `.dev-server/` ein. Verwendet werden die deklarierten Mindestversionen Admin 7.6.20 und js-controller 6.0.11 sowie `--noBrowserSync`. Der VE.Direct-Adapter selbst wird nicht gestartet und benötigt daher keinen Serialport. `playwright-core` steuert das bereits installierte Chrome ohne Playwright-Runner oder Browser-Download.

Abgedeckt sind:

- initiale Defaults ohne ungewolltes Speichern,
- Umschalten seriell/TCP und Control-Opt-ins,
- ungültige Hosts, Ports, Stromwerte und Refresh-Intervalle,
- IPv4 und IPv6,
- Speichern und Reload nativer Werte,
- Erhalt versteckter Werte ohne unbeabsichtigte Änderungen,
- keine Browser-`pageerror`-Ereignisse.

Der Workflow `.github/workflows/test-and-release.yml` führt diesen Test als separaten `admin-e2e`-Job auf Ubuntu/Node 24 aus. Der Release-`before_commit`-Hook führt ihn ebenfalls aus. Optional kann mit `CHROME_PATH` ein Browserbinary oder mit `ADMIN_E2E_URL` ein bereits laufender Admin verwendet werden. `CHROME_CHANNEL` überschreibt den Standardkanal `chrome`.

Das isolierte dev-server-Profil enthält einen eigenen Abhängigkeitsbaum mit den ausdrücklich gewählten Mindestversionen und wird weder in das Produktivpaket noch in die Produktivkonfiguration übernommen. Es darf nicht als Vorlage für eine produktive Installation alter Versionen verstanden werden.
