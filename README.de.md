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
- History der letzten 10 abgeschlossenen Einsätze (`einsatz.json.history10`)
- Getrennte Handler für Alarm (`io.new_waip`), Rückmeldung (`io.new_rmld`),
  Routen (`io.routes`), TTS (`io.playtts`) und Standby (`io.standby`)
- Automatisches Session-Cookie-Management (siehe unten), damit die
  Alarm-Zustellung auch ohne offene Browsersitzung dauerhaft weiterläuft
- Server-Neustart-Erkennung über `io.version` mit automatischem
  Session-Refresh + Reconnect
- Einsatz-, Rückmeldungs-, Routen- und Einsatzmittel-Daten als eigene,
  flache JSON-Arrays unter `einsatz.json.*` – ohne Verschachtelung, damit
  VIS-Tabellen-Widgets direkt daran binden können
- Aggregierte Rückmeldungs-Zähler pro Rolle/Fähigkeit, analog zu den
  Live-Badges der Weboberfläche
- Sauberer Zustand bei jedem Neustart: alle States werden beim Adapter-
  Start aktiv auf ihren leeren Wert zurückgesetzt (`false`/`0`/`null`/
  `[]`), außer `einsatz.json.history10` und `debug.monitorAudit` (beide
  bleiben über Neustarts hinweg erhalten). Startet der Adapter neu,
  während gerade ein Einsatz läuft, werden dessen Live-Felder
  (`einsatz.*`) ebenfalls geleert und füllen sich erst wieder, sobald
  der Server das nächste Event zu diesem Einsatz sendet.
- Schutz vor veralteten Daten: Beginnt ein neuer Einsatz, bevor für ihn
  eigene Routen-/Rückmeldungs-Events eingetroffen sind, werden
  `einsatz.json.routen`/`.rueckmeldungen` und die Rückmeldungs-Zähler
  sofort geleert, statt auf diese Events zu warten. Und falls `io.standby`
  für einen Einsatz jemals verpasst wird (z.B. durch einen Disconnect
  zum falschen Zeitpunkt), schließt ein Watchdog den Einsatz automatisch
  ab, sobald seine `ablaufzeit` um mehr als eine Gnadenfrist (60
  Sekunden) überschritten ist, statt unbegrenzt veraltete "aktiv"-Daten
  stehen zu lassen.

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

Rückmeldungen und Routen sind pro Einsatz Listen (1:n). Sie liegen als
**flache** JSON-Arrays unter `einsatz.json.*` (keine verschachtelten
Objekte/Arrays innerhalb einer Zeile), damit sie direkt an VIS-Tabellen-
Widgets gebunden werden können – ergänzt um schnell bindbare Zähler,
damit Bindings und Trigger komplett ohne JSON-Parsing auskommen.

### info

| State | Typ | Beschreibung |
| --- | --- | --- |
| `connection` | boolean | Standard-ioBroker-Indikator: Verbindung zum WAIP-Server aktiv |

### status

| State | Typ | Beschreibung |
| --- | --- | --- |
| `connected` | boolean | Socket.IO-Verbindung technisch aufgebaut |
| `registeredMonitor` | string | Zuletzt beim Server registrierte Monitor-ID |
| `registeredMonitorName` | string | Anzeigename dieses Monitors ohne ID (z. B. „Leitstelle: Lausitz"); wird einmalig beim Start von derselben `/waip/`-Übersichtsseite wie das Admin-Dropdown aufgelöst, `null` falls nicht auflösbar |
| `registrationAccepted` | boolean | `true` sobald das erste Event empfangen wurde, sonst `false` direkt nach Connect oder nach Ablauf des Registrierungs-Timeouts |
| `registrationPending` | boolean | `true` direkt nach Connect, solange noch auf eine Antwort vom Server gewartet wird, sonst `false` sobald bestätigt oder Timeout erreicht |

### einsatz

Flache Felder des aktuell laufenden Einsatzes. Werden bei `io.standby`
geleert (`null`/`0`), analog zum offiziellen Frontend – `alarmAktiv` ist
damit ein verlässlicher Schalter dafür, ob hier gerade echte Live-Daten
stehen. Der zuletzt abgeschlossene Einsatz bleibt trotzdem über
`einsatz.json.history10` abrufbar:

| State | Typ | Beschreibung |
| --- | --- | --- |
| `alarmAktiv` | boolean | `true` seit dem letzten `io.new_waip`, `false` seit dem letzten `io.standby` |
| `restzeit` | number (s) | Verbleibende Sekunden bis `ablaufzeit`, sekündlich aktualisiert |
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
| `ablaufzeit` | string (date) | Ende der Standby-Anzeigedauer, Basis für `restzeit` |
| `einsatznummer` | string | Einsatznummer (sofern vom Server vergeben) |
| `sondersignal` | number | `1` = Sondersignal, sonst kein Sondersignal |
| `permissions` | string | Berechtigungsflag der Registrierung (Vollzugriff auf Detailkarte ja/nein); wird immer als String gespeichert (z.B. `"true"`), da der Server hier ein rohes Boolean sendet |
| `latitude` / `longitude` | number | Position des Einsatzortes (normalisiert aus wgs84-Feldern oder GeoJSON-Mittelpunkt) |
| `routenGesamt` | number | Anzahl Routen im aktuellen Einsatz |
| `rueckmeldungGesamt` | number | Rückmeldungen gesamt im aktuellen Einsatz |
| `rueckmeldungAnzahl.ek` | number | Anzahl Rückmeldungen als Einsatzkraft |
| `rueckmeldungAnzahl.gf` | number | Anzahl Rückmeldungen als Gruppenführer |
| `rueckmeldungAnzahl.zf` | number | Anzahl Rückmeldungen als Zugführer |
| `rueckmeldungAnzahl.vf` | number | Anzahl Rückmeldungen als Verbandsführer |
| `rueckmeldungAnzahl.agt` | number | Anzahl Rückmeldungen mit Atemschutz-Befähigung |
| `rueckmeldungAnzahl.fzf` | number | Anzahl Rückmeldungen als Fahrzeugführer |
| `rueckmeldungAnzahl.ma` | number | Anzahl Rückmeldungen als Maschinist |
| `rueckmeldungAnzahl.med` | number | Anzahl Rückmeldungen mit medizinischer Befähigung |

### einsatz.json

Flache JSON-Objekte/Arrays, maximal eine Verschachtelungsebene, gedacht
zum direkten Binden an VIS-Tabellen-Widgets (verschachtelte Strukturen wie
ein einfaches `{routen, rueckmeldungen, ...}`-Objekt werden von diesen
Widgets in der Regel nicht dargestellt). `routen`/`rueckmeldungen`/
`emAlarmiert`/`emWeitere` enthalten immer nur die Daten des **aktuellen**
Einsatzes – sie werden bei `io.standby` geleert (`[]`) und sind **nicht**
Teil der History. `permissions` innerhalb von `current`/`history10` wird
genauso als String gespeichert wie im eigenständigen
`einsatz.permissions`-State.

| State | Typ | Beschreibung |
| --- | --- | --- |
| `current` | string (JSON-Array) | Flache Daten des aktuellen Einsatzes: dieselben 19 Felder wie die einzelnen `einsatz.*`-States oben (`id` … `permissions`, plus `lat`/`lon`), gebündelt als ein Objekt innerhalb eines Arrays mit einem Element (`[]` falls kein Einsatz aktiv) – der Array-Wrapper ist nötig, weil die meisten Tabellen-Widgets am Root ein Array statt eines nackten Objekts erwarten |
| `history10` | string (JSON-Array) | Letzte 10 abgeschlossenen Einsätze, gleiches Schema wie `current`, ein Array-Eintrag pro Einsatz, geschrieben bei `io.standby` |
| `routen` | string (JSON-Array) | Routen des aktuellen Einsatzes; jeder Eintrag hat `nr_wache`, `name_wache`, `color`, `lat`, `lon` (`position` zu flachem `lat`/`lon` aufgelöst) |
| `rueckmeldungen` | string (JSON-Array) | Rückmeldungen des aktuellen Einsatzes, wie vom Server empfangen |
| `emAlarmiert` | string (JSON-Array) | Alarmierte Einsatzmittel des aktuellen Einsatzes; jeder Eintrag hat `name`, `zeit`, `wache`, `zeit_alarmierung_iso`, `zeit_ausgerueckt_iso` |
| `emWeitere` | string (JSON-Array) | Weitere Einsatzmittel des aktuellen Einsatzes, gleiches Schema wie `emAlarmiert` |

### einsatz.tts

Sprachansage (`io.playtts`) zum aktuell laufenden Einsatz – liegt unter
`einsatz` statt in einem eigenen Top-Level-Kanal, da sie ohne Einsatzbezug
keine Bedeutung hat. Keine History: eine TTS-Ansage ist nur im Moment
relevant, deshalb wird nur die jeweils letzte vorgehalten.

| State | Typ | Beschreibung |
| --- | --- | --- |
| `last` | string (URL) | Vollständige, absolute URL zur mp3-Datei der letzten Sprachansage. Der Server sendet nur einen (oft relativen) Pfad, der als `audio.src` in einem Browser mit derselben Origin gedacht ist; der Adapter löst diesen gegen die konfigurierte WAIP-Server-URL auf, damit der Link auch außerhalb der WAIP-Web-Seite funktioniert (z.B. in einem VIS-Audio-Widget) |
| `lastTimestamp` | string (date) | Zeitpunkt der letzten Ansage |

### debug

| State | Typ | Beschreibung |
| --- | --- | --- |
| `lastEvent` | string (JSON) | Letztes empfangenes Socket-Event (Name + Zeitstempel), zur Verbindungsdiagnose |
| `normalizedPosition` | string (JSON) | Ergebnis der Geodaten-Normalisierung für das letzte `io.new_waip`-Event, als flaches `{lat, lon}`-Objekt (beide `null`, falls keine gültige Position ermittelt werden konnte) |
| `rawPayloadShort` | string | Vorschau (500 Zeichen) der rohen, unnormalisierten `io.new_waip`-Nutzlast |
| `ignoredCount` | number | Anzahl verworfener Events (Payload nannte explizit eine andere Monitor-ID) |
| `monitorAudit` | string (JSON-Array) | Chronologisches Log von Connect-/Registrierungs-/Reconnect-Ereignissen (200 Einträge) |
| `sessionExpires` | string (date) | Ablaufzeit des Session-Cookies laut letzter Erneuerung |
| `lastError` | string | Letzte vom Server gemeldete Fehlermeldung (`io.error`); reiner Text, kein JSON, da der Server hier einen bloßen String sendet |
| `serverVersion` | string | Zuletzt gemeldete Server-Instanz-ID (`io.version`); Änderung deutet auf Server-Neustart hin |


---

Lizenz und vollständiges Changelog stehen in der
[englischen README](README.md#license) (`## License`, `## Changelog`).
