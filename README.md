# ioBroker.WAIP-Web

[![Test and Release](https://github.com/rnc11/ioBroker.waip-web/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/rnc11/ioBroker.waip-web/actions/workflows/test-and-release.yml)

## English

Unofficial ioBroker adapter for **Wachalarm IP-Web (WAIP-Web)**

Connects via Socket.IO to a WAIP-Web dispatch monitor and mirrors incidents
("Einsatz"), responder feedback ("Rückmeldung"), routes and TTS
announcements into ioBroker states – without needing a browser tab to stay
open.

### About this adapter

This adapter is an **unofficial community project** and has no connection
to the WAIP-Web project, to Robert-112, or to the operator of any specific
instance (e.g. the Integrated Regional Dispatch Center Lausitz /
Integrierte Regionalleitstelle Lausitz). It was built by analyzing the
behavior of the frontend (`client_waip.js`) that a WAIP-Web instance
publicly serves to any browser, in order to replicate the same Socket.IO
events and data fields a regular browser client receives.

The adapter connects **without logging in** and therefore only ever
receives WAIP-Web's public permission tier (keyword, location, approximate
position, alerted resources, feedback) – the same data any anonymous
browser visitor would see without signing in. No access restrictions are
bypassed.

> **Note:** An always-on automated client like this adapter is different
> from an occasionally opened browser tab. Before running it against a
> production instance, briefly check with the operator/your dispatch
> center whether a permanent automated connection is welcome.

### About WAIP-Web

[Wachalarm IP-Web](https://github.com/Robert-112/n112_waip-web) is an
open-source web application by **Robert-112** that displays dispatch/alert
information for fire departments and EMS device-independently in the
browser (Windows, Linux, Mac, smartphone – no installation needed). Among
other things it offers:

- **Alarm monitor** – incident type, keyword, special signal, location,
  map, alerted resources, app-based responder feedback including voice
  announcements
- **Dashboard** – overview of all ongoing incidents
- **Feedback function** – app-based responder feedback, grouped by role
  (EK/GF/ZF/VF) and additional qualification (AGT/FZF/MA/MED)
- **Administration** – user management, station data, monitor overview

WAIP-Web itself is licensed under
[**Creative Commons BY-SA 4.0**](https://creativecommons.org/licenses/by-sa/4.0/).
This adapter contains no code from the WAIP-Web project; it implements an
independent client for its Socket.IO interface.

### Features

- Connects to the `/waip` namespace via `socket.io-client`, registers via
  `emit('WAIP', monitorId)` (emitted 3× for robustness)
- Manual reconnect handling (the library's own auto-reconnect is
  disabled) with a configurable delay
- Registration timeout with an audit log (`debug.monitorAudit`)
- Geodata normalization (wgs84 fields, `position`, or GeoJSON `geometry`
  → centroid)
- History of the last 10 completed incidents (`einsatz.history10`)
- Separate handlers for alarm (`io.new_waip`), feedback (`io.new_rmld`),
  routes (`io.routes`), TTS (`io.playtts`) and standby (`io.standby`)
- Automatic session-cookie management (see below), so alarm delivery
  keeps working indefinitely without an open browser session
- Server-restart detection via `io.version`, with automatic session
  refresh + reconnect
- Complete incident data including nested feedback/routes per incident
  (feedback and routes are 1:n relationships)
- Aggregated feedback counters per role/capability, mirroring the live
  badges on the web UI

#### Why a session cookie is needed

The WAIP-Web server ties alarm delivery to an Express session cookie,
which a browser renews automatically every few minutes via a bundled
script. A plain Socket.IO client never gets this cookie automatically –
the adapter therefore fetches it itself via `GET /session/keepalive` and
attaches it to the Socket.IO connection.

According to the WAIP-Web source code, the cookie's lifetime is
**configurable per instance via an environment variable** (server
default: 60 seconds; this instance apparently uses 10 minutes) – a fixed
renewal interval would therefore potentially be wrong for other WAIP-Web
instances. The adapter instead derives the actual interval **adaptively**
from the expiry time the server reports on every call (80% of the
observed lifetime, at least 55 seconds, at most a fixed 5-minute ceiling)
– the exact same clamping that `/js/session_keepalive.js` on the site
itself uses.

### Configuration

In the admin UI of the adapter instance:

| Field | Description | Default |
| --- | --- | --- |
| WAIP server URL | Base URL of the WAIP-Web instance | `https://wachalarm.leitstelle-lausitz.de` |
| Monitor ID | Picked from a live dropdown, fetched from the configured server's `/waip/` overview page and grouped by Leitstelle/Kreis/Träger/Wache; manual entry stays possible if the server can't be reached. Empty/`0` = global monitor (all incidents) | *(empty)* |
| Registration timeout (s) | Time until a missing registration confirmation is logged | `10` |
| Reconnect delay (s) | Wait time before a manual reconnect after disconnect/error | `5` |

The session keepalive interval is **not configurable** – it's derived
fully automatically on every renewal from the cookie lifetime the server
reports (min. 55s, max. 5 min., matching `/js/session_keepalive.js` on
the site itself).

### States (under `waip-web.0.*`)

Feedback and routes are 1:n lists per incident and are therefore stored
as nested JSON arrays inside `einsatz.json` and in every entry of
`einsatz.history10` – complemented by quick-to-bind counters so VIS
bindings and triggers don't need JSON parsing.

#### info

| State | Type | Description |
| --- | --- | --- |
| `connection` | boolean | Standard ioBroker indicator: connection to the WAIP server active |

#### status

| State | Type | Description |
| --- | --- | --- |
| `connected` | boolean | Socket.IO connection technically established |
| `alarmAktiv` | boolean | `true` since the last `io.new_waip`, `false` since the last `io.standby` |
| `restzeit` | number (s) | Remaining seconds until `einsatz.ablaufzeit`, updated every second |
| `registeredMonitor` | string | Monitor ID last registered with the server |
| `registeredMonitorName` | string | Display name of that monitor, without the ID (e.g. "Leitstelle: Lausitz"); resolved once at startup from the same `/waip/` overview page as the admin dropdown, `null` if it couldn't be resolved |
| `registrationAccepted` | mixed | `"pending"` right after connecting, `true` once the first event was received, otherwise `false` once the registration timeout elapses |

#### einsatz

Flat fields of the currently running incident. Cleared (`null`/`0`) on
`io.standby`, matching the official frontend – `status.alarmAktiv` is
therefore a reliable switch for whether these fields currently hold real
live data. The most recently finished incident remains available via
`einsatz.history10`:

| State | Type | Description |
| --- | --- | --- |
| `id` | number | Internal incident ID |
| `uuid` | string | Unique incident UUID (also used to associate feedback) |
| `einsatzart` | string | e.g. "Brandeinsatz" (fire), "Hilfeleistungseinsatz" (technical assistance), "Rettungseinsatz" (rescue/EMS), "Krankentransport" (patient transport) |
| `stichwort` | string | Alarm keyword |
| `ort` | string | Location/town |
| `ortsteil` | string | District (if different from `ort`) |
| `strasse` / `hausnummer` | string | Address |
| `objekt` / `objektteil` | string | Building name and part |
| `einsatzdetails` | string | Extra details (only populated for fire/technical-assistance incidents) |
| `besonderheiten` | string | Free-text remarks from the dispatch center |
| `zeitstempel` | string (date) | Alarm time |
| `ablaufzeit` | string (date) | End of the standby display duration, basis for `status.restzeit` |
| `einsatznummer` | string | Incident number (if assigned by the server) |
| `sondersignal` | number | `1` = special signal (lights & siren), otherwise none |
| `permissions` | mixed | The registration's permission flag (full access to the detail map yes/no) |
| `latitude` / `longitude` | number | Incident location (normalized from wgs84 fields or GeoJSON centroid) |
| `json` | string (JSON) | Complete incident object: all fields above plus `emAlarmiert[]`, `emWeitere[]`, `routen[]`, `rueckmeldungen[]` |
| `history10` | string (JSON array) | Last 10 completed incidents, same object shape as `json`, written on `io.standby` |
| `routenGesamt` | number | Number of routes in the current incident (= `json.routen.length`) |
| `rueckmeldungGesamt` | number | Total feedback count for the current incident |
| `rueckmeldungAnzahl.ek` | number | Feedback count as team member ("Einsatzkraft") |
| `rueckmeldungAnzahl.gf` | number | Feedback count as crew leader ("Gruppenführer") |
| `rueckmeldungAnzahl.zf` | number | Feedback count as division chief ("Zugführer") |
| `rueckmeldungAnzahl.vf` | number | Feedback count as group commander ("Verbandsführer") |
| `rueckmeldungAnzahl.agt` | number | Feedback count with breathing-apparatus qualification ("Atemschutzgeräteträger") |
| `rueckmeldungAnzahl.fzf` | number | Feedback count as vehicle commander ("Fahrzeugführer") |
| `rueckmeldungAnzahl.ma` | number | Feedback count as driver/operator ("Maschinist") |
| `rueckmeldungAnzahl.med` | number | Feedback count with a medical qualification |

#### tts

| State | Type | Description |
| --- | --- | --- |
| `last` | string (URL) | URL of the most recently received voice announcement |
| `lastTimestamp` | string (date) | Time of the last announcement |
| `history10` | string (JSON array) | Last 10 announcements as `{zeitstempel, url}` |

#### debug

| State | Type | Description |
| --- | --- | --- |
| `lastEvent` | string (JSON) | Last received socket event (name + timestamp), for connection diagnostics |
| `normalizedPosition` | string (JSON) | Last normalized position of the incident |
| `rawPayloadShort` | string | Preview (500 characters) of the raw, unnormalized `io.new_waip` payload |
| `ignoredCount` | number | Count of discarded events (payload explicitly named a different monitor ID) |
| `monitorAudit` | string (JSON array) | Chronological log of connect/registration/reconnect events (200 entries) |
| `sessionExpires` | string (date) | Expiry time of the session cookie as of the last renewal |
| `lastError` | string (JSON) | Last error message reported by the server (`io.error`) |
| `serverVersion` | string | Last reported server instance ID (`io.version`); a change suggests a server restart |

JSON-internal keys inside `einsatz.json` (`emAlarmiert`, `emWeitere`,
`routen`, `rueckmeldungen`) stay lowercase – these are object properties
inside the JSON value, not their own ioBroker states.

## Deutsch

Inoffizieller ioBroker-Adapter für **Wachalarm IP-Web (WAIP-Web)**

Verbindet sich per Socket.IO mit einem WAIP-Web-Wachalarm-Monitor und bildet
Einsätze, Rückmeldungen, Routen und TTS-Ansagen als ioBroker-States ab –
ohne dass ein Browser-Tab dauerhaft offen sein muss.

### Über diesen Adapter

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

### Über WAIP-Web

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

### Funktionen

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

#### Warum ein Session-Cookie nötig ist

Der WAIP-Web-Server bindet die Alarm-Zustellung an einen
Express-Session-Cookie, den ein Browser über ein mitgeliefertes Skript
automatisch alle paar Minuten erneuert. Ein reiner Socket.IO-Client bekommt
diesen Cookie nie automatisch – der Adapter holt ihn deshalb selbst per
`GET /session/keepalive` und hängt ihn an die Socket.IO-Verbindung an.

Die Cookie-Lebensdauer ist laut Quellcode von WAIP-Web **pro Instanz per
Umgebungsvariable konfigurierbar** (Server-Standard: 60 Sekunden; diese
Instanz nutzt offenbar 10 Minuten) – ein fest angenommenes Erneuerungs-
intervall wäre daher für andere WAIP-Web-Instanzen potenziell falsch. Der
Adapter leitet das tatsächliche Intervall deshalb **adaptiv** aus der vom
Server bei jedem Aufruf gemeldeten Ablaufzeit ab (80 % der beobachteten
Laufzeit, mindestens 55 Sekunden, höchstens die konfigurierte Obergrenze) –
genau die gleiche Klammerung, die auch `/js/session_keepalive.js` der
Website selbst verwendet.

### Konfiguration

In der Admin-Oberfläche der Adapterinstanz:

| Feld | Beschreibung | Default |
| --- | --- | --- |
| WAIP-Server-URL | Basis-URL der WAIP-Web-Instanz | `https://wachalarm.leitstelle-lausitz.de` |
| Monitor-ID | Auswahl per Live-Dropdown, geladen von der `/waip/`-Übersichtsseite des konfigurierten Servers und gruppiert nach Leitstelle/Kreis/Träger/Wache; manuelle Eingabe bleibt möglich, falls der Server nicht erreichbar ist. Leer/`0` = globaler Monitor (alle Einsätze) | *(leer)* |
| Registrierungs-Timeout (s) | Zeit bis eine ausbleibende Registrierungsbestätigung geloggt wird | `10` |
| Wiederverbindungs-Verzögerung (s) | Wartezeit vor manuellem Reconnect nach Disconnect/Fehler | `5` |

Das Session-Keepalive-Intervall ist **nicht konfigurierbar** – es wird bei
jeder Erneuerung vollautomatisch aus der vom Server gemeldeten Cookie-
Laufzeit abgeleitet (min. 55s, max. 5 Min., analog zu
`/js/session_keepalive.js` der Website selbst).

### States (unter `waip-web.0.*`)

Rückmeldungen und Routen sind pro Einsatz Listen (1:n) und liegen deshalb
als verschachtelte JSON-Arrays in `einsatz.json` bzw. in jedem Eintrag von
`einsatz.history10` – ergänzt um schnell bindbare Zähler, damit VIS-Bindings
und Trigger ohne JSON-Parsing auskommen.

#### info

| State | Typ | Beschreibung |
| --- | --- | --- |
| `connection` | boolean | Standard-ioBroker-Indikator: Verbindung zum WAIP-Server aktiv |

#### status

| State | Typ | Beschreibung |
| --- | --- | --- |
| `connected` | boolean | Socket.IO-Verbindung technisch aufgebaut |
| `alarmAktiv` | boolean | `true` seit dem letzten `io.new_waip`, `false` seit dem letzten `io.standby` |
| `restzeit` | number (s) | Verbleibende Sekunden bis `einsatz.ablaufzeit`, sekündlich aktualisiert |
| `registeredMonitor` | string | Zuletzt beim Server registrierte Monitor-ID |
| `registeredMonitorName` | string | Anzeigename dieses Monitors ohne ID (z. B. „Leitstelle: Lausitz"); wird einmalig beim Start von derselben `/waip/`-Übersichtsseite wie das Admin-Dropdown aufgelöst, `null` falls nicht auflösbar |
| `registrationAccepted` | mixed | `"pending"` direkt nach Connect, `true` sobald das erste Event empfangen wurde, sonst `false` nach Ablauf des Registrierungs-Timeouts |

#### einsatz

Flache Felder des aktuell laufenden Einsatzes. Werden bei `io.standby`
geleert (`null`/`0`), analog zum offiziellen Frontend – `status.alarmAktiv`
ist damit ein verlässlicher Schalter dafür, ob hier gerade echte Live-Daten
stehen. Der zuletzt abgeschlossene Einsatz bleibt trotzdem über
`einsatz.history10` abrufbar:

| State | Typ | Beschreibung |
| --- | --- | --- |
| `id` | number | Interne Einsatz-ID |
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
| `sondersignal` | number | `1` = Sondersignal, sonst kein Sondersignal |
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

#### tts

| State | Typ | Beschreibung |
| --- | --- | --- |
| `last` | string (URL) | URL der zuletzt empfangenen Sprachansage |
| `lastTimestamp` | string (date) | Zeitpunkt der letzten Ansage |
| `history10` | string (JSON-Array) | Letzte 10 Ansagen als `{zeitstempel, url}` |

#### debug

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

## License

MIT License (this adapter) – see [LICENSE](LICENSE).

The adapter connects to instances of
[WAIP-Web](https://github.com/Robert-112/n112_waip-web), which is licensed
under CC BY-SA 4.0 by Robert-112. This adapter contains no code from that
project.

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

## Changelog

### 0.6.5 (2026-08-21)

- Fixed all issues reported by the official [ioBroker adapter checker](https://adapter-check.iobroker.in/):
  - Bumped the required `js-controller` dependency to `>=5.0.19` and `@iobroker/adapter-core` to `^3.2.2`
  - Replaced the deprecated `common.license`/`common.title`/`common.main` fields with `common.licenseInformation`/`common.titleLang`; `common.main` is redundant with `package.json`'s `main` field
  - Added the required `common.tier` (`2` - external/cloud data source)
  - Added translations of `titleLang`, `desc` and the kept `common.news` entries into all 10 additional ioBroker admin languages (ru, pt, nl, fr, it, es, pl, uk, zh-cn)
  - Trimmed `common.news` to the 7 most recent entries, as recommended (the repository builder truncates there anyway); the full history stays in this changelog

### 0.6.4 (2026-08-21)

- New state `status.registeredMonitorName` shows the registered monitor
  as text without the ID (e.g. "Leitstelle: Lausitz"), resolved once at
  startup from the same `/waip/` overview page as the admin dropdown.
  `status.registeredMonitor` is unchanged and keeps showing the ID.

### 0.6.3 (2026-08-21)

- Admin UI: the Monitor ID field is now always full-width, placed on its
  own row below the WAIP server URL, so the (sometimes long) dropdown
  entries have enough room to display without being cramped.

### 0.6.2 (2026-08-21)

- Monitor dropdown entries are now sorted by numeric monitor ID instead
  of following the source page's (per-category) order.

### 0.6.1 (2026-08-21)

- Monitor dropdown entries now start with the actual monitor ID, e.g.
  "4 - Leitstelle: Lausitz", so the numeric ID stays visible even after
  a monitor has been selected.

### 0.6.0 (2026-08-21)

- **Admin UI:** Monitor ID is now a live dropdown (`selectSendTo`) instead
  of a plain text field. The adapter fetches the configured server's
  public `/waip/` overview page on demand and offers every monitor it
  finds there, grouped by Leitstelle/Kreis/Träger/Wache, with "Alle
  Wachalarme" (ID `0`) as an explicit first option. Manual entry remains
  available if the server can't be reached or uses a different page
  layout, so existing configurations keep working unchanged.
- Removed the static "session keepalive interval" info text from the
  admin UI (the behavior itself is unchanged - see [Why a session cookie
  is needed](#why-a-session-cookie-is-needed)).
- Added help text to the "Registration timeout" and "Reconnect delay"
  fields.

### 0.5.1 (2026-08-21)

- **Logging:** Reclassified log levels so `warn` becomes a reliable signal
  again. Session-cookie rotation, the known "Fehler beim Erneuern der
  Session" server message, and detected server restarts are now logged
  as `info` instead of `warn`, since they're part of this instance's
  normal, self-healing ~10-minute session cycle. Events discarded for a
  different monitor ID are now `info` (frequency remains tracked via
  `debug.ignoredCount`). Failures that only affect internal housekeeping
  (`debug.monitorAudit`, socket cleanup) are now `debug`. A duplicate
  `connect_error` log line (logged once at `warn`, once at `info`) was
  removed. Introduced `error` level for cases where an incident,
  feedback, route or TTS event genuinely failed to be processed (actual
  data loss), so these now stand out instead of being buried among
  routine `warn` noise.

### 0.5.0 (2026-08-20)

- **Behavior change:** On `io.standby`, all `einsatz.*` states (including
  `einsatz.json` and all counters) are now cleared instead of leaving the
  finished incident's data in place – matching the official frontend,
  which also clears keyword, location data etc. on standby.
  `status.alarmAktiv` is therefore now a reliable switch for whether
  `einsatz.*` currently holds real live data. The finished incident
  remains fully available via `einsatz.history10` (archived there first).

### 0.4.9 (2026-08-20)

- **CI fix:** Reverted a self-introduced, unnecessary line wrap in
  `connect()` (engine-packet preview) – `prettier/prettier` flagged it as
  superfluous; the line actually fits on one line within the configured
  print width.

### 0.4.8 (2026-08-20)

- **CI fix:** Fixed the final 16 lint errors – this time the complete,
  non-truncated error list including the exact desired replacement text
  was available, so every location could be corrected precisely 1:1
  (line wraps for overly long calls/objects, one `prefer-template`
  case). Lint should now be fully green.

### 0.4.7 (2026-08-20)

- **CI fix:** Fixed the remaining lint errors in `main.js` – consistently
  applied `curly` (braces even for single-line `if`/`for`),
  `no-unused-vars` for empty `catch` blocks (`catch (e) {}` → `catch {}`
  where `e` isn't used), and `arrowParens: avoid` (removed parentheses
  around single-parameter arrow functions). Purely mechanical code-style
  fixes, no behavior change.

### 0.4.6 (2026-08-20)

- **CI fix:** The `lint` step failed with hundreds of formatting errors
  (e.g. "Replace 'x' with "x""). Cause: `@iobroker/eslint-config`
  requires its own `prettier.config.mjs` in addition to
  `eslint.config.mjs`, re-exporting the ioBroker formatting style
  (single quotes, 4-space indentation, `trailingComma: 'all'`) – without
  it, Prettier fell back to its own defaults (double quotes). File added.

### 0.4.5 (2026-08-20)

- **CI fix:** The first pipeline run failed with "Dependencies lock file
  is not found". Cause: `actions/setup-node`'s built-in npm caching
  needs a `package-lock.json` for its cache key, independent of the
  install command used. Since none is committed to the repo yet,
  `package-cache: 'false'` is now set on both jobs.

### 0.4.4 (2026-08-20)

- Set up the CI pipeline (`.github/workflows/test-and-release.yml`),
  following the standard pattern of the official
  `@iobroker/create-adapter` template: a `check-and-lint` job (ESLint
  via `@iobroker/eslint-config`) and an `adapter-tests` matrix (Node
  20/22/24 × Ubuntu/Windows/macOS) via the central
  `testing-action-check`/`testing-action-adapter` actions. Added
  `test/package.js` and `test/integration.js` (`@iobroker/testing`)
  plus `eslint.config.mjs` for this; bumped `@iobroker/testing` to
  `^5.2.2`. Since no `package-lock.json` is committed yet, the pipeline
  uses `npm install` instead of `npm ci`.
- Raised `engines.node` in `package.json` to `>=18` (matching the tested
  Node versions and `@iobroker/testing` 5.x's requirements)
- A `deploy` job (automatic npm publishing) is prepared but commented
  out until npm Trusted Publishing is set up

### 0.4.3 (2026-08-20)

- **Bugfix:** `einsatz.id` and `einsatz.sondersignal` were declared as
  `string`, but the server actually sends them as numbers
  (`sondersignal`, per `client_waip.js`: `switch (data.sondersignal) {
  case 1: ... }`) – ioBroker therefore logged a type warning on every
  incident. Both states are now declared as `number`. Existing objects
  with the old (wrong) type are automatically recreated on the next
  adapter start (`migrateObjectTypes()`, generic for future type
  corrections).

### 0.4.2 (2026-08-20)

- Removed the "Session keepalive interval – upper bound" config field
  again: the official `/js/session_keepalive.js` on the site hard-codes
  this upper bound at 5 minutes and doesn't make it configurable. Having
  an admin field for it wrongly suggested a fixed interval, even though
  the actual renewal has long been fully automatic (see 0.4.1). The
  upper bound is now likewise fixed at 5 minutes.

### 0.4.1 (2026-08-20)

- **Robustness:** The session keepalive interval is now adaptive instead
  of a fixed assumption. WAIP-Web's source code (`server/app_cfg.js`)
  shows that the session cookie's lifetime is configurable per instance
  via an environment variable (server default: 60s instead of the
  previously assumed 10 minutes) – the adapter now derives the renewal
  interval from the expiry time actually reported by the server
  (matching `/js/session_keepalive.js` on the site: 80% of the observed
  lifetime, min. 55s, at most the configured upper bound). The "Session
  keepalive interval" config option is accordingly now an upper bound
  rather than a fixed interval.
- Corrected a comment about `io.version`/server restarts: per
  `server/auth.js`, WAIP-Web stores sessions persistently (SQLite), not
  in-memory – a restart therefore normally doesn't clear them. The
  proactive session refresh + reconnect on server restart remains as a
  general safeguard, only the previous justification was inaccurate.

### 0.4.0 (2026-08-20)

- **Restructured the object tree:** Feedback and routes are 1:n lists
  per incident and now live as nested JSON arrays inside one overall
  object `einsatz.json` (including `emAlarmiert[]`, `emWeitere[]`,
  `routen[]`, `rueckmeldungen[]`) instead of several loose states.
- `einsatz.history10` replaces `history.last10` – now with the **full**
  nested incident object per entry instead of just 6 reduced fields.
- New counters directly under `einsatz.*`: `routenGesamt`,
  `rueckmeldungGesamt`, `rueckmeldungAnzahl.{ek,gf,zf,vf,agt,fzf,ma,med}`
  (replaces `rueckmeldung.counts.*`).
- `einsatz.latitude`/`einsatz.longitude` replace
  `geo.latitude`/`geo.longitude` (position is additionally available in
  `einsatz.json.position`).
- New state `tts.history10` (last 10 TTS announcements).
- **Removed:** the entire `vis.*` channel, `json.raw`, `json.einsatz`,
  `geo.position`, `rueckmeldung.last.json`, `routen.json`,
  `routen.count`, `einsatz.emWeitere` (now part of `einsatz.json`).
- The adapter automatically removes all obsolete objects from the
  previous structure on its first start after the update
  (`cleanupObsoleteObjects()`).

### 0.3.4 (2026-08-20)

- All state names (`common.name`) consistently switched to German
  (previously a mix of English and German) – the adapter only makes
  sense for German-speaking users anyway

### 0.3.3 (2026-08-20)

- **Bugfix (potential data loss):** For a specific monitor ID (≠ `0`),
  events were silently discarded ("unknownMonitor") after the
  registration timeout elapsed, because real WAIP payloads, per
  `client_waip.js`, **never** contain a monitor-identifying field – that
  assignment happens entirely server-side via Socket.IO rooms. As a
  result, alarm delivery could stop completely after 10s even though
  the connection was technically up. `status.registrationAccepted`
  stayed permanently `false` for the same reason, even for the global
  monitor (`0`). Now any received event confirms the registration;
  events are only discarded if a payload explicitly names a different
  monitor ID.

### 0.3.2 (2026-08-20)

- Also switched the "Registration timeout" and "Reconnect delay" config
  fields from milliseconds to seconds (`registrationTimeout` →
  `registrationTimeoutSec`, default `10`; `reconnectDelay` →
  `reconnectDelaySec`, default `5`). Existing instances without a newly
  set value automatically use the defaults.

### 0.3.1 (2026-08-20)

- Switched the "Session keepalive interval" config field from
  milliseconds to seconds (`sessionKeepaliveInterval` →
  `sessionKeepaliveIntervalSec`, still defaulting to 5 min = `300`).
  Existing instances without a newly set value automatically use the
  default.

### 0.3.0 (2026-08-20)

- **Bugfix:** `wgs84_x`/`wgs84_y` were swapped (latitude/longitude). Per
  the official web frontend (`client_waip.js`), `wgs84_x = latitude,
  wgs84_y = longitude` – contrary to the usual GIS convention.
  `geo.latitude`/`geo.longitude` were therefore swapped for directly
  transmitted coordinates (not the GeoJSON fallback path).
- Added the missing `io.standby` handler: `status.alarmAktiv` was
  previously never reset when an incident ended
- Captured new incident fields (previously only contained in the raw
  `json.raw`/`json.einsatz`, now as their own states): `zeitstempel`,
  `einsatznummer`, `objekt`, `objektteil`, `strasse`, `hausnummer`,
  `einsatzdetails`, `besonderheiten`, `permissions`
- `em_alarmiert` (alerted resources) is now stored in
  `vis.fahrzeugTabelle`, `em_weitere` in `einsatz.emWeitere`
- Feedback is now collected per incident (`vis.rueckmeldungenTabelle`)
  and aggregated into counters per role/capability
  (`rueckmeldung.counts.*`), mirroring the live badges
  (EK/GF/ZF/VF/AGT/FZF/MA/MED) on the web UI
- New handlers for `io.error` (→ `debug.lastError`) and `io.version`
  (server-restart detection → session-cookie refresh + forced reconnect)
- Generalized `reconnectForRotatedSession()` into the more generic
  `forceReconnect(reason)` (now also used on a server version change)

### 0.2.1 (2026-08-20)

- Detected session-cookie rotation: if `/session/keepalive` returns a
  different cookie value than before (e.g. because the old session was
  already invalid server-side – a missed keepalive, a server restart
  with an in-memory session store), an existing Socket.IO connection is
  now actively rebuilt with the new session instead of waiting for a
  silent failure

### 0.2.0 (2026-08-20)

- Introduced session-cookie management: the adapter fetches and renews
  the WAIP server's `connect.sid` session cookie itself (`GET
  /session/keepalive`, matching `/js/session_keepalive.js` on the site)
  and attaches it to the Socket.IO connection. Fixes alarm delivery
  stopping after about 10 minutes without an active browser session.
- New state `debug.sessionExpires` and a new config option "Session
  keepalive interval (ms)" (default `300000`)

### 0.1.1 (2026-08-20)

- Adopted the favicon from `wachalarm.leitstelle-lausitz.de` as the
  adapter icon (`admin/waip-web.png`), replacing the previous
  placeholder
- Renamed the GitHub repository from `ioBroker.WAIP-Web` to
  `ioBroker.waip-web` (uppercase letters in the repo name prevented
  installation via `iobroker url` with `Process exited with code 25`);
  updated all URLs in `package.json`/`io-package.json` accordingly

### 0.1.0 (2026-08-20)

- Initial version: ported the original "WAIP Instrumented v3.9" ioBroker
  JavaScript-adapter script into a standalone adapter. The URL/monitor
  ID now come from the admin configuration instead of a runtime state.
