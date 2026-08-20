# ioBroker.WAIP-Web

Inoffizieller ioBroker-Adapter für **Wachalarm IP-Web (WAIP-Web)**

Verbindet sich per Socket.IO mit einem WAIP-Web-Wachalarm-Monitor und bildet
Einsätze, Rückmeldungen, Routen und TTS-Ansagen als ioBroker-States ab –
ohne dass ein Browser-Tab dauerhaft offen sein muss.

## Über diesen Adapter

Dieser Adapter ist ein **inoffizielles Community-Projekt** und steht in
keiner Verbindung zum WAIP-Web-Projekt, zu Robert-112 oder zum Betreiber
einer konkreten Instanz (z. B. der Integrierten Regionalleitstelle
Lausitz). Er wurde entwickelt, indem das öffentlich über den Browser
ausgelieferte Frontend (`client_waip.js`) einer WAIP-Web-Instanz auf sein
Verhalten hin analysiert wurde, um dieselben Socket.IO-Events und
Datenfelder nachzubilden, die auch ein regulärer Browser-Client empfängt.

Der Adapter meldet sich **ohne Login** an und erhält dadurch ausschließlich
die öffentliche Berechtigungsstufe von WAIP-Web (Stichwort, Ort, ungefähre
Position, alarmierte Einsatzmittel, Rückmeldungen) – dieselben Daten, die
auch ein anonymer Browser-Besucher ohne Anmeldung sehen würde. Es werden
keine Zugriffsbeschränkungen umgangen.

> **Hinweis:** Ein automatisierter Dauerclient wie dieser Adapter ist etwas
> anderes als ein gelegentlich geöffneter Browser-Tab. Bevor du den Adapter
> gegen eine produktive Instanz laufen lässt, sprich kurz mit dem
> Betreiber/deiner Leitstelle ab, ob eine dauerhafte automatisierte
> Verbindung erwünscht ist.

## Über WAIP-Web

[Wachalarm IP-Web](https://github.com/Robert-112/n112_waip-web) ist eine
quelloffene Webanwendung von **Robert-112**, die Alarmierungsinformationen
für Feuerwehr/Rettungsdienst geräteunabhängig im Browser darstellt (Windows,
Linux, Mac, Smartphone – keine Installation nötig). Sie bietet u. a.:

- **Alarmmonitor** – Einsatzart, Stichwort, Sondersignal, Ort, Karte,
  alarmierte Einsatzmittel, App-Rückmeldungen der Einsatzkräfte inkl.
  Sprachansage
- **Dashboard** – Gesamtübersicht laufender Einsätze
- **Rückmeldefunktion** – App-basierte Rückmeldungen der Einsatzkräfte,
  gegliedert nach Rolle (EK/GF/ZF/VF) und Zusatzfunktion (AGT/FZF/MA/MED)
- **Administration** – Nutzerverwaltung, Wachdaten, Monitor-Übersicht

WAIP-Web selbst ist unter der
[**Creative Commons BY-SA 4.0**](https://creativecommons.org/licenses/by-sa/4.0/deed.de)
lizenziert. Dieser Adapter enthält keinen Code aus dem WAIP-Web-Projekt,
sondern implementiert eine eigenständige Anbindung an dessen Socket.IO-
Schnittstelle.

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
  Routen (`io.routes`), TTS (`io.playtts`) und Standby (`io.standby`)
- Automatisches Session-Cookie-Management (siehe unten), damit die
  Alarm-Zustellung auch ohne offene Browsersitzung dauerhaft weiterläuft
- Server-Neustart-Erkennung über `io.version` mit automatischem
  Session-Refresh + Reconnect
- Vollständige Einsatzdaten inkl. verschachtelter Rückmeldungen/Routen
  pro Einsatz (Rückmeldungen und Routen sind 1:n-Beziehungen)
- Aggregierte Rückmeldungs-Zähler pro Rolle/Fähigkeit, analog zu den
  Live-Badges der Weboberfläche

### Warum ein Session-Cookie nötig ist

Der WAIP-Web-Server bindet die Alarm-Zustellung an einen
Express-Session-Cookie (10 Minuten gültig), den ein Browser über ein
mitgeliefertes Skript automatisch alle paar Minuten erneuert. Ein reiner
Socket.IO-Client bekommt diesen Cookie nie automatisch – der Adapter holt
ihn deshalb selbst per `GET /session/keepalive`, hängt ihn an die
Socket.IO-Verbindung an und erneuert ihn periodisch (Standard: alle 5 Min.).

## Konfiguration

In der Admin-Oberfläche der Adapterinstanz:

| Feld | Beschreibung | Default |
| --- | --- | --- |
| WAIP-Server-URL | Basis-URL der WAIP-Web-Instanz | `https://wachalarm.leitstelle-lausitz.de` |
| Monitor-ID | Monitor-Kennung; leer/`0` = globaler Monitor | *(leer)* |
| Registrierungs-Timeout (s) | Zeit bis eine ausbleibende Registrierungsbestätigung geloggt wird | `10` |
| Wiederverbindungs-Verzögerung (s) | Wartezeit vor manuellem Reconnect nach Disconnect/Fehler | `5` |
| Session-Keepalive-Intervall (s) | Wie oft der Session-Cookie per `GET /session/keepalive` erneuert wird | `300` (5 Min) |

## States (unter `waip-web.0.*`)

Rückmeldungen und Routen sind pro Einsatz Listen (1:n) und liegen deshalb
als verschachtelte JSON-Arrays in `einsatz.json` bzw. in jedem Eintrag von
`einsatz.history10` – ergänzt um schnell bindbare Zähler, damit VIS-Bindings
und Trigger ohne JSON-Parsing auskommen.

### info

| State | Typ | Beschreibung |
| --- | --- | --- |
| `connection` | boolean | Standard-ioBroker-Indikator: Verbindung zum WAIP-Server aktiv |

### status

| State | Typ | Beschreibung |
| --- | --- | --- |
| `connected` | boolean | Socket.IO-Verbindung technisch aufgebaut |
| `alarmAktiv` | boolean | `true` seit dem letzten `io.new_waip`, `false` seit dem letzten `io.standby` |
| `restzeit` | number (s) | Verbleibende Sekunden bis `einsatz.ablaufzeit`, sekündlich aktualisiert |
| `registeredMonitor` | string | Zuletzt beim Server registrierte Monitor-ID |
| `registrationAccepted` | mixed | `"pending"` direkt nach Connect, `true` sobald das erste Event empfangen wurde, sonst `false` nach Ablauf des Registrierungs-Timeouts |

### einsatz

Flache Felder des aktuell laufenden bzw. zuletzt bekannten Einsatzes (bleiben
nach `io.standby` als letzter bekannter Stand erhalten, bis ein neuer Einsatz
eintrifft):

| State | Typ | Beschreibung |
| --- | --- | --- |
| `id` | string | Interne Einsatz-ID |
| `uuid` | string | Eindeutige Einsatz-UUID (dient auch der Zuordnung von Rückmeldungen) |
| `einsatzart` | string | z. B. „Brandeinsatz", „Hilfeleistungseinsatz", „Rettungseinsatz", „Krankentransport" |
| `stichwort` | string | Alarmstichwort |
| `ort` | string | Ort |
| `ortsteil` | string | Ortsteil (falls abweichend vom Ort) |
| `strasse` / `hausnummer` | string | Adresse |
| `objekt` / `objektteil` | string | Gebäude-/Objektname und -teil |
| `einsatzdetails` | string | Zusatzdetails (nur bei Brand-/Hilfeleistungseinsätzen befüllt) |
| `besonderheiten` | string | Freitext-Besonderheiten der Leitstelle |
| `zeitstempel` | string (date) | Alarmzeit |
| `ablaufzeit` | string (date) | Ende der Standby-Anzeigedauer, Basis für `status.restzeit` |
| `einsatznummer` | string | Einsatznummer (sofern vom Server vergeben) |
| `sondersignal` | string | `1` = Sondersignal, sonst kein Sondersignal |
| `permissions` | mixed | Berechtigungsflag der Registrierung (Vollzugriff auf Detailkarte ja/nein) |
| `latitude` / `longitude` | number | Position des Einsatzortes (normalisiert aus wgs84-Feldern oder GeoJSON-Mittelpunkt) |
| `json` | string (JSON) | Vollständiges Einsatz-Objekt: alle Felder oben plus `emAlarmiert[]`, `emWeitere[]`, `routen[]`, `rueckmeldungen[]` |
| `history10` | string (JSON-Array) | Letzte 10 abgeschlossenen Einsätze, gleicher Objekt-Shape wie `json`, geschrieben bei `io.standby` |
| `routenGesamt` | number | Anzahl Routen im aktuellen Einsatz (= `json.routen.length`) |
| `rueckmeldungGesamt` | number | Rückmeldungen gesamt im aktuellen Einsatz |
| `rueckmeldungAnzahl.ek` | number | Anzahl Rückmeldungen als Einsatzkraft |
| `rueckmeldungAnzahl.gf` | number | Anzahl Rückmeldungen als Gruppenführer |
| `rueckmeldungAnzahl.zf` | number | Anzahl Rückmeldungen als Zugführer |
| `rueckmeldungAnzahl.vf` | number | Anzahl Rückmeldungen als Verbandsführer |
| `rueckmeldungAnzahl.agt` | number | Anzahl Rückmeldungen mit Atemschutz-Befähigung |
| `rueckmeldungAnzahl.fzf` | number | Anzahl Rückmeldungen als Fahrzeugführer |
| `rueckmeldungAnzahl.ma` | number | Anzahl Rückmeldungen als Maschinist |
| `rueckmeldungAnzahl.med` | number | Anzahl Rückmeldungen mit medizinischer Befähigung |

### tts

| State | Typ | Beschreibung |
| --- | --- | --- |
| `last` | string (URL) | URL der zuletzt empfangenen Sprachansage |
| `lastTimestamp` | string (date) | Zeitpunkt der letzten Ansage |
| `history10` | string (JSON-Array) | Letzte 10 Ansagen als `{zeitstempel, url}` |

### debug

| State | Typ | Beschreibung |
| --- | --- | --- |
| `lastEvent` | string (JSON) | Letztes empfangenes Socket-Event (Name + Zeitstempel), zur Verbindungsdiagnose |
| `normalizedPosition` | string (JSON) | Zuletzt normalisierte Position des Einsatzes |
| `rawPayloadShort` | string | Vorschau (500 Zeichen) der rohen, unnormalisierten `io.new_waip`-Nutzlast |
| `ignoredCount` | number | Anzahl verworfener Events (Payload nannte explizit eine andere Monitor-ID) |
| `monitorAudit` | string (JSON-Array) | Chronologisches Log von Connect-/Registrierungs-/Reconnect-Ereignissen (200 Einträge) |
| `sessionExpires` | string (date) | Ablaufzeit des Session-Cookies laut letzter Erneuerung |
| `lastError` | string (JSON) | Letzte vom Server gemeldete Fehlermeldung (`io.error`) |
| `serverVersion` | string | Zuletzt gemeldete Server-Instanz-ID (`io.version`); Änderung deutet auf Server-Neustart hin |

JSON-interne Schlüssel innerhalb von `einsatz.json` (`emAlarmiert`,
`emWeitere`, `routen`, `rueckmeldungen`) bleiben kleingeschrieben – das sind
Objekteigenschaften im JSON-Wert, keine eigenen ioBroker-States.

## Installation / Entwicklung

Node.js (>=16) und npm werden benötigt:

```bash
npm install
```

Adapter danach z. B. über den ioBroker-Admin (Custom-URL-Installation von
GitHub) oder per `iobroker url <github-url>` einbinden.

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

MIT License (dieser Adapter) – siehe [LICENSE](LICENSE).

Der Adapter verbindet sich mit Instanzen von
[WAIP-Web](https://github.com/Robert-112/n112_waip-web), das unter
CC BY-SA 4.0 durch Robert-112 lizenziert ist. Dieser Adapter enthält
keinen Code aus diesem Projekt.

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
