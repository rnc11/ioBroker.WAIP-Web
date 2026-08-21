![Logo](admin/waip-web-logo.png)

# ioBroker.waip-web

🇬🇧 [English version of this README](README.md)

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

## Konfiguration

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
| `registeredMonitorName` | string | Anzeigename dieses Monitors ohne ID (z. B. „Leitstelle: Lausitz"); wird einmalig beim Start von derselben `/waip/`-Übersichtsseite wie das Admin-Dropdown aufgelöst, `null` falls nicht auflösbar |
| `registrationAccepted` | boolean | `true` sobald das erste Event empfangen wurde, sonst `false` direkt nach Connect oder nach Ablauf des Registrierungs-Timeouts |
| `registrationPending` | boolean | `true` direkt nach Connect, solange noch auf eine Antwort vom Server gewartet wird, sonst `false` sobald bestätigt oder Timeout erreicht |

### einsatz

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
| `permissions` | string | Berechtigungsflag der Registrierung (Vollzugriff auf Detailkarte ja/nein); wird immer als String gespeichert (z.B. `"true"`), da der Server hier ein rohes Boolean sendet |
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

---

Lizenz und vollständiges Changelog stehen in der
[englischen README](README.md#license) (`## License`, `## Changelog`).
