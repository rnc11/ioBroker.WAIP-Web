# ioBroker.WAIP-Web

Wachalarm IP-Web Adapter

Verbindet sich per Socket.IO mit einem WAIP-Wachalarm-Monitor (z. B.
`wachalarm.leitstelle-lausitz.de`) und bildet Einsätze, Rückmeldungen,
Routen und TTS-Ansagen als ioBroker-States ab.

## Funktionen

- Verbindung zum Namespace `/waip` per `socket.io-client`, Registrierung
  über `emit('WAIP', monitorId)` (3-faches Emit für Robustheit)
- Manuelles Reconnect-Handling (kein Auto-Reconnect der Bibliothek) mit
  konfigurierbarer Verzögerung
- Registrierungs-Timeout mit Audit-Log (`debug.monitorAudit`)
- Normalisierung von Geodaten (wgs84-Felder, `position` oder
  GeoJSON-`geometry` → Mittelpunkt)
- History der letzten 10 abgeschlossenen Einsätze (`einsatz.history10`)
- Getrennte Handler für Alarm (`io.new_waip`), Rückmeldung (`io.new_rmld`),
  Routen (`io.routes`) und TTS (`io.playtts`)
- Automatisches Session-Cookie-Management: Der WAIP-Server erwartet einen
  Express-Session-Cookie (10 Minuten gültig, wie ihn ein echter Browser
  über `/js/session_keepalive.js` erneuert). Der Adapter holt diesen Cookie
  selbst per `GET /session/keepalive`, hängt ihn an die Socket.IO-Verbindung
  an und erneuert ihn periodisch – damit läuft die Alarm-Zustellung auch
  ohne echte Browsersitzung dauerhaft weiter
- Zusätzliche Handler für `io.standby` (Einsatz beendet → `status.alarmAktiv`
  wird zurückgesetzt), `io.error` (Server-Fehlermeldungen → `debug.lastError`)
  und `io.version` (Server-Neustart-Erkennung → Session-Refresh + Reconnect)
- Vollständige Einsatzdaten laut offiziellem Web-Frontend (`client_waip.js`):
  Alarmzeitstempel, Einsatznummer, Objekt/Objektteil, Adresse, Besonderheiten
  als eigene flache States, plus ein verschachteltes Gesamtobjekt (`einsatz.json`)
  mit alarmierten Einsatzmitteln, Routen und allen Rückmeldungen als JSON-Arrays
  (Rückmeldungen und Routen sind pro Einsatz Listen – 1:n-Beziehung)
- Aggregierte Rückmeldungs-Zähler pro Rolle/Fähigkeit (`einsatz.rueckmeldungAnzahl.*`
  für EK/GF/ZF/VF/AGT/FZF/MA/MED, `einsatz.rueckmeldungGesamt`) und
  `einsatz.routenGesamt`, analog zu den Live-Zählern der Weboberfläche

## Konfiguration

In der Admin-Oberfläche der Adapterinstanz:

| Feld | Beschreibung | Default |
| --- | --- | --- |
| WAIP-Server-URL | Basis-URL des WAIP-Servers | `https://wachalarm.leitstelle-lausitz.de` |
| Monitor-ID | Monitor-Kennung; leer/`0` = globaler Monitor | *(leer)* |
| Registrierungs-Timeout (s) | Zeit bis eine ausbleibende Registrierungsbestätigung geloggt wird | `10` |
| Wiederverbindungs-Verzögerung (s) | Wartezeit vor manuellem Reconnect nach Disconnect/Fehler | `5` |
| Session-Keepalive-Intervall (s) | Wie oft der Session-Cookie per `GET /session/keepalive` erneuert wird | `300` (5 Min) |

## States (unter `waip-web.0.*`)

Rückmeldungen und Routen sind pro Einsatz Listen (1:n) und liegen deshalb als
verschachtelte JSON-Arrays in `einsatz.json` bzw. in jedem Eintrag von
`einsatz.history10` – ergänzt um schnell bindbare Zähler, damit VIS-Bindings
und Trigger ohne JSON-Parsing auskommen.

**info** – `connection`

**status** – `connected`, `alarmAktiv`, `restzeit`, `registeredMonitor`, `registrationAccepted`

**einsatz** – flache Felder des aktuellen Einsatzes:
`id`, `uuid`, `einsatzart`, `stichwort`, `ort`, `ortsteil`, `strasse`, `hausnummer`,
`objekt`, `objektteil`, `einsatzdetails`, `besonderheiten`, `zeitstempel`, `ablaufzeit`,
`einsatznummer`, `sondersignal`, `permissions`, `latitude`, `longitude`

- `einsatz.json` – vollständiges Einsatz-Objekt inkl. `emAlarmiert[]`, `emWeitere[]`,
  `routen[]`, `rueckmeldungen[]` (JSON)
- `einsatz.history10` – letzte 10 abgeschlossene Einsätze, gleicher Objekt-Shape wie
  `einsatz.json` (JSON-Array, geschrieben bei `io.standby` bzw. beim nächsten neuen Einsatz)
- `einsatz.routenGesamt`, `einsatz.rueckmeldungGesamt` – Zähler
- `einsatz.rueckmeldungAnzahl.ek` / `gf` / `zf` / `vf` / `agt` / `fzf` / `ma` / `med`

**tts** – `last`, `lastTimestamp`, `history10`

**debug** – `lastEvent`, `normalizedPosition`, `rawPayloadShort`, `ignoredCount`,
`monitorAudit`, `sessionExpires`, `lastError`, `serverVersion`

JSON-interne Schlüssel innerhalb von `einsatz.json` (`emAlarmiert`, `emWeitere`, `routen`,
`rueckmeldungen`) bleiben kleingeschrieben – das sind Objekteigenschaften im JSON-Wert,
keine eigenen ioBroker-States.

## Installation / Entwicklung

Node.js (>=16) und npm werden benötigt, waren beim Erstellen dieses
Gerüsts auf diesem Rechner nicht installiert:

```bash
npm install
```

Adapter danach z. B. über den ioBroker-Admin (`Adapter aus lokalem
Verzeichnis installieren`) oder per Symlink in die ioBroker-`node_modules`
einbinden.

## Changelog

### 0.4.0 (2026-08-20)

- **Objektstruktur überarbeitet:** Rückmeldungen und Routen sind pro Einsatz
  Listen (1:n) und liegen jetzt als verschachtelte JSON-Arrays in einem
  Gesamtobjekt `einsatz.json` (inkl. `emAlarmiert[]`, `emWeitere[]`, `routen[]`,
  `rueckmeldungen[]`) statt in mehreren losen States.
- `einsatz.history10` ersetzt `history.last10` – jetzt mit dem **vollständigen**
  verschachtelten Einsatz-Objekt pro Eintrag statt nur 6 reduzierten Feldern.
- Neue Zähler direkt unter `einsatz.*`: `routenGesamt`, `rueckmeldungGesamt`,
  `rueckmeldungAnzahl.{ek,gf,zf,vf,agt,fzf,ma,med}` (ersetzt `rueckmeldung.counts.*`).
- `einsatz.latitude`/`einsatz.longitude` ersetzen `geo.latitude`/`geo.longitude`
  (Position liegt zusätzlich in `einsatz.json.position`).
- Neuer State `tts.history10` (letzte 10 TTS-Ansagen).
- **Entfernt:** kompletter `vis.*`-Kanal, `json.raw`, `json.einsatz`,
  `geo.position`, `rueckmeldung.last.json`, `routen.json`, `routen.count`,
  `einsatz.emWeitere` (jetzt Teil von `einsatz.json`).
- Der Adapter entfernt beim ersten Start nach dem Update alle veralteten
  Objekte aus der vorherigen Struktur automatisch (`cleanupObsoleteObjects()`).

### 0.3.4 (2026-08-20)

- Alle State-Bezeichnungen (`common.name`) konsequent auf Deutsch
  umgestellt (vorher teils Englisch, teils Deutsch gemischt) – der Adapter
  ist ohnehin nur für den deutschsprachigen Raum sinnvoll

### 0.3.3 (2026-08-20)

- **Bugfix (potenzieller Datenverlust):** Bei einer konkreten Monitor-ID
  (≠ `0`) wurden Events nach Ablauf des Registrierungs-Timeouts still
  verworfen ("unknownMonitor"), weil reale WAIP-Payloads laut
  `client_waip.js` **nie** ein Monitor-Kennungsfeld enthalten – die
  Zuordnung passiert komplett serverseitig über Socket.IO-Rooms. Dadurch
  konnte die Alarm-Zustellung nach 10s vollständig stillstehen, obwohl die
  Verbindung technisch stand. `status.registrationAccepted` blieb aus
  demselben Grund auch bei globalem Monitor (`0`) dauerhaft `false`.
  Jetzt bestätigt jedes empfangene Event die Registrierung; verworfen wird
  nur noch, wenn ein Payload explizit eine andere Monitor-ID nennt.

### 0.3.2 (2026-08-20)

- Konfigurationsfelder „Registrierungs-Timeout" und „Wiederverbindungs-
  Verzögerung" ebenfalls von Millisekunden auf Sekunden umgestellt
  (`registrationTimeout` → `registrationTimeoutSec`, Default `10`;
  `reconnectDelay` → `reconnectDelaySec`, Default `5`). Bestehende
  Instanzen ohne neu gesetzten Wert nutzen automatisch die Defaults.

### 0.3.1 (2026-08-20)

- Konfigurationsfeld „Session-Keepalive-Intervall" von Millisekunden auf
  Sekunden umgestellt (`sessionKeepaliveInterval` → `sessionKeepaliveIntervalSec`,
  Default weiterhin 5 Min = `300`). Bestehende Instanzen ohne neu gesetzten
  Wert nutzen automatisch den Default.

### 0.3.0 (2026-08-20)

- **Bugfix:** `wgs84_x`/`wgs84_y` waren vertauscht (Breiten-/Längengrad).
  Laut offiziellem Web-Frontend (`client_waip.js`) gilt
  `wgs84_x = Breitengrad, wgs84_y = Längengrad` – entgegen der üblichen
  GIS-Konvention. `geo.latitude`/`geo.longitude` waren dadurch bei direkt
  übermittelten Koordinaten (nicht GeoJSON-Fallback) vertauscht.
- Fehlender `io.standby`-Handler ergänzt: `status.alarmAktiv` wurde bisher
  nie zurückgesetzt, wenn ein Einsatz beendet ist
- Neue Einsatz-Felder erfasst (bisher nur im rohen `json.raw`/`json.einsatz`
  enthalten, jetzt als eigene States): `zeitstempel`, `einsatznummer`,
  `objekt`, `objektteil`, `strasse`, `hausnummer`, `einsatzdetails`,
  `besonderheiten`, `permissions`
- `em_alarmiert` (alarmierte Einsatzmittel) wird jetzt in
  `vis.fahrzeugTabelle` abgelegt, `em_weitere` in `einsatz.emWeitere`
- Rückmeldungen werden jetzt pro Einsatz gesammelt (`vis.rueckmeldungenTabelle`)
  und zu Zählern pro Rolle/Fähigkeit aggregiert (`rueckmeldung.counts.*`),
  analog zu den Live-Badges (EK/GF/ZF/VF/AGT/FZF/MA/MED) der Weboberfläche
- Neue Handler für `io.error` (→ `debug.lastError`) und `io.version`
  (Server-Neustart-Erkennung → Session-Cookie-Refresh + erzwungener Reconnect)
- `reconnectForRotatedSession()` zu generischem `forceReconnect(reason)`
  verallgemeinert (wird jetzt auch bei Server-Versionswechsel genutzt)

### 0.2.1 (2026-08-20)

- Session-Cookie-Rotation erkannt: Liefert `/session/keepalive` einen
  anderen Cookie-Wert als zuvor (z. B. weil die alte Session serverseitig
  bereits ungültig war – verpasster Keepalive, Server-Neustart mit
  In-Memory-Sessionstore), wird eine bestehende Socket.IO-Verbindung jetzt
  aktiv mit der neuen Session neu aufgebaut, statt auf einen stillen
  Ausfall zu warten

### 0.2.0 (2026-08-20)

- Session-Cookie-Management eingeführt: Der Adapter holt und erneuert
  selbstständig den `connect.sid`-Session-Cookie des WAIP-Servers
  (`GET /session/keepalive`, analog zu `/js/session_keepalive.js` der
  Website) und hängt ihn an die Socket.IO-Verbindung an. Behebt, dass die
  Alarm-Zustellung nach ca. 10 Minuten ohne aktive Browsersitzung aufhörte.
- Neuer State `debug.sessionExpires` sowie neue Konfigurationsoption
  „Session-Keepalive-Intervall (ms)" (Default `300000`)

### 0.1.1 (2026-08-20)

- Favicon von `wachalarm.leitstelle-lausitz.de` als Adapter-Icon
  (`admin/waip-web.png`) übernommen, ersetzt den bisherigen Platzhalter
- Repository auf GitHub von `ioBroker.WAIP-Web` auf `ioBroker.waip-web`
  umbenannt (Großbuchstaben im Repo-Namen verhinderten die Installation
  per `iobroker url` mit `Process exited with code 25`); alle URLs in
  `package.json`/`io-package.json` entsprechend angepasst

### 0.1.0 (2026-08-20)

- Erste Version: Portierung des ursprünglichen "WAIP Instrumented v3.9"
  ioBroker-JavaScript-Adapter-Scripts in einen eigenständigen Adapter.
  URL/Monitor-ID kommen jetzt aus der Admin-Konfiguration statt aus einem
  Laufzeit-State.

## License

MIT License

Copyright (c) 2026 rnc11

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
