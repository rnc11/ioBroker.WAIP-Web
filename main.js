'use strict';

/*
 * ioBroker.WAIP-Web
 *
 * Verbindet sich mit einem WAIP-Wachalarm-Monitor (Socket.IO) und bildet
 * Einsätze, Rückmeldungen, Routen und TTS-Ansagen als ioBroker-States ab.
 *
 * Ported from the original "WAIP Instrumented" ioBroker-JavaScript-Adapter
 * script into a standalone adapter: URL/Monitor-ID kommen jetzt aus der
 * Admin-Konfiguration statt aus einem Laufzeit-State.
 *
 * Objektstruktur (Stand 0.7.15): einsatz.json ist ein eigener Channel mit
 * ausschließlich flachen JSON-States, da VIS-Tabellen-Widgets keine
 * verschachtelten Strukturen darstellen können. einsatz.json.current /
 * .history10 enthalten nur den flachen Einsatzstamm (dieselben Felder wie
 * die einzelnen einsatz.*-States, nur als ein JSON-Objekt bzw. -Array
 * gebündelt); Routen/Rückmeldungen/Alarmierungen liegen als eigene, ebenfalls
 * flache Arrays in einsatz.json.routen/.rueckmeldungen/.emAlarmiert/
 * .emWeitere - nur für den jeweils aktuellen Einsatz, nicht historisiert.
 * Ergänzt um schnell bindbare Zähler (einsatz.routenGesamt,
 * einsatz.rueckmeldungGesamt, einsatz.rueckmeldungAnzahl.*). Der frühere
 * vis.*-Kanal entfällt komplett.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');
const utils = require('@iobroker/adapter-core');
const { io } = require('socket.io-client');

const DEFAULT_URL = 'https://wachalarm.leitstelle-lausitz.de';
const DEFAULT_SESSION_KEEPALIVE_SEC = 300; // Obergrenze, wie /js/session_keepalive.js der Seite selbst
// Untergrenze fürs Keepalive-Intervall, analog zur Klammerung in /js/session_keepalive.js
// (min(max(maxAge*0.8, 55s), Obergrenze)). Die tatsächliche Cookie-Laufzeit ist je
// WAIP-Web-Instanz per ENV konfigurierbar (Server-Default lt. server/app_cfg.js: 60s!) -
// deshalb wird das Intervall unten adaptiv aus der vom Server gemeldeten Ablaufzeit
// berechnet, statt einen festen Wert anzunehmen.
const SESSION_KEEPALIVE_MIN_MS = 55 * 1000;
const HISTORY_SIZE = 10;
// einsatznummer/objekt/objektteil/besonderheiten/strasse/hausnummer/einsatzdetails/permissions
// wurden mit 0.7.18 entfernt: server/waip.js von WAIP-Web befüllt diese Felder serverseitig
// nur für eingeloggte Clients (db_user_check_permission_for_waip) - da dieser Adapter sich
// bewusst ohne Login verbindet (siehe "Über diesen Adapter"), waren sie immer leer bzw.
// permissions immer false. Siehe OBSOLETE_OBJECT_IDS für die zugehörige Migration.
const ALLOWED_EINSATZ_FIELDS = [
    'id',
    'uuid',
    'einsatzart',
    'stichwort',
    'ort',
    'ortsteil',
    'ablaufzeit',
    'sondersignal',
    // laut client_waip.js (offizielles Frontend) zusätzlich vorhandenes Feld:
    'zeitstempel',
];
const RUECKMELDUNG_ANZAHL_KEYS = ['ek', 'gf', 'zf', 'vf', 'agt', 'fzf', 'ma', 'med'];
const DISCONNECT_DEDUPE_MS = 60000; // suppress identical disconnect logs for 60s
const WARN_DEDUPE_MS = 5000;
// Obergrenze für die Anzahl unterschiedlicher Nachrichten, die safeLog() gleichzeitig für
// die Dedupe vorhält - verhindert unbegrenztes Wachstum über eine lange Laufzeit, falls
// viele verschiedene (z.B. dynamische) Fehlermeldungen auftreten. Wird der Cache voll,
// wird er komplett geleert (führt höchstens zu vereinzelt nicht deduplizierten Meldungen,
// unkritisch - die Dedupe ist eine Rausch-Reduzierung, keine Korrektheitsanforderung).
const WARN_DEDUPE_CACHE_MAX = 200;
// Für die Eskalation wiederholter "Event für anderen Monitor"-Meldungen (siehe
// wrapHandlerWithMonitorCheck/checkWrongMonitorRate) - Hinweis auf eine falsch
// konfigurierte Monitor-ID, statt dauerhaft nur auf info zu bleiben.
const WRONG_MONITOR_WARN_THRESHOLD = 20;
const WRONG_MONITOR_WARN_WINDOW_MS = 5 * 60 * 1000;
// Toleranz nach Ablauf von einsatz.ablaufzeit, bevor der Watchdog in restzeitInterval ein
// verpasstes io.standby annimmt und den Einsatz automatisch abschließt (siehe dort).
const MISSED_STANDBY_GRACE_MS = 60000;

/* Für die dynamische Monitor-Auswahl im Admin (siehe fetchMonitorList/onMessage):
   Die /waip/-Übersichtsseite einer WAIP-Web-Instanz gliedert die verfügbaren
   Monitore typischerweise in diese vier Überschriften. Nicht jede Instanz nutzt
   zwingend exakt diese Gliederung - findet fetchMonitorList() keine davon, wird
   die komplette Seite als eine einzige, unkategorisierte Liste geparst. */
const MONITOR_CATEGORY_HEADINGS = [
    { key: 'leitstelle', re: /Alarmmonitor\s+Leitstelle/i },
    { key: 'kreis', re: /Alarmmonitor\s+Kreis/i },
    { key: 'traeger', re: /Alarmmonitor\s+Tr(?:&auml;|ä)ger/i },
    { key: 'wache', re: /Alarmmonitor\s+Wache/i },
];
const MONITOR_CATEGORY_LABELS = { leitstelle: 'Leitstelle', kreis: 'Kreis', traeger: 'Träger', wache: 'Wache' };

// State-Objekte, die beim Start aus früheren Versionen entfernt werden (Struktur-Migration).
const OBSOLETE_OBJECT_IDS = [
    'json.raw',
    'json.einsatz',
    'vis.fahrzeugTabelle',
    'vis.einsatzTabelle',
    'vis.rueckmeldungenTabelle',
    'geo.latitude',
    'geo.longitude',
    'geo.position',
    'history.last10',
    'einsatz.emWeitere',
    // Umstrukturierung in 0.7.15: einsatz.json/einsatz.history10 wechseln von State zu
    // Channel (einsatz.json.current/.history10/.routen/.rueckmeldungen/.emAlarmiert/
    // .emWeitere) - ein Objekt kann nicht gleichzeitig State und Channel sein, die alten
    // States müssen daher vor initObjects() entfernt werden.
    'einsatz.json',
    'einsatz.history10',
    // Umstrukturierung in 0.7.15: Kanal tts zieht komplett unter einsatz um
    // (einsatz.tts.last/.lastTimestamp), da er sich auf den aktuellen Einsatz bezieht.
    // tts.history10 entfällt ersatzlos (keine sinnvolle Historie ohne Einsatzbezug).
    'tts.last',
    'tts.lastTimestamp',
    'tts.history10',
    'tts',
    // Umstrukturierung in 0.7.15: status.alarmAktiv/status.restzeit ziehen unter einsatz
    // um (einsatz.alarmAktiv/.restzeit), da sie sich auf den aktuellen Einsatz beziehen.
    'status.alarmAktiv',
    'status.restzeit',
    'rueckmeldung.last.json',
    'rueckmeldung.counts.ek',
    'rueckmeldung.counts.gf',
    'rueckmeldung.counts.zf',
    'rueckmeldung.counts.vf',
    'rueckmeldung.counts.agt',
    'rueckmeldung.counts.fzf',
    'rueckmeldung.counts.ma',
    'rueckmeldung.counts.med',
    'rueckmeldung.counts.gesamt',
    'routen.json',
    'routen.count',
    // Umstrukturierung in 0.7.18: diese Felder werden von WAIP-Web serverseitig ohnehin nur
    // befüllt, wenn der verbindende Client eingeloggt ist (siehe db_user_check_permission_for_waip
    // in server/waip.js) - da dieser Adapter sich bewusst ohne Login verbindet, waren sie immer
    // leer bzw. permissions immer false. Ersatzlos entfernt statt dauerhaft leere States zu führen.
    'einsatz.einsatznummer',
    'einsatz.objekt',
    'einsatz.objektteil',
    'einsatz.besonderheiten',
    'einsatz.strasse',
    'einsatz.hausnummer',
    'einsatz.einsatzdetails',
    'einsatz.permissions',
];

// Übergeordnete Channel/Folder-Objekte, die für jeden State-Zweig existieren müssen.
// ioBroker verlangt ein eigenes Objekt für jedes Segment eines State-Pfads - reine
// State-Blätter (siehe STATE_DEFS) reichen dafür nicht aus.
const CHANNEL_DEFS = [
    { id: 'status', type: 'channel', name: 'Verbindungs- und Registrierungsstatus' },
    { id: 'einsatz', type: 'channel', name: 'Aktueller Einsatz' },
    { id: 'einsatz.rueckmeldungAnzahl', type: 'folder', name: 'Rückmeldungen nach Funktion' },
    { id: 'einsatz.json', type: 'folder', name: 'Einsatzdaten als flache JSON-Objekte/Arrays für Tabellen-Widgets' },
    { id: 'einsatz.tts', type: 'folder', name: 'TTS-Ansage des aktuellen Einsatzes' },
    { id: 'debug', type: 'channel', name: 'Diagnose- und Debug-Informationen' },
];

// Definition aller States, die beim Start sichergestellt werden.
const STATE_DEFS = [
    {
        id: 'status.connected',
        type: 'boolean',
        role: 'indicator.reachable',
        name: 'Verbunden mit WAIP-Server',
        def: false,
    },
    { id: 'status.registeredMonitor', type: 'string', role: 'text', name: 'Aktuell registrierte Monitor-ID' },
    {
        id: 'status.registeredMonitorName',
        type: 'string',
        role: 'text',
        name: 'Aktuell registrierter Monitor (Text, ohne ID)',
    },
    {
        id: 'status.registrationAccepted',
        type: 'boolean',
        role: 'indicator',
        name: 'Registrierung bestätigt',
        def: false,
    },
    {
        id: 'status.registrationPending',
        type: 'boolean',
        role: 'indicator',
        name: 'Registrierung angefragt, Antwort vom Server steht noch aus',
        def: false,
    },
    { id: 'debug.lastEvent', type: 'string', role: 'json', name: 'Letztes empfangenes Socket-Event' },
    { id: 'debug.normalizedPosition', type: 'string', role: 'json', name: 'Letzte normalisierte Position' },
    { id: 'debug.rawPayloadShort', type: 'string', role: 'text', name: 'Rohdaten-Vorschau (500 Zeichen)' },
    {
        id: 'debug.ignoredCount',
        type: 'number',
        role: 'value',
        name: 'Anzahl ignorierter Events (explizit falsches Monitor-Feld im Payload)',
        def: 0,
    },
    { id: 'debug.monitorAudit', type: 'string', role: 'json', name: 'Monitor-Audit-Log (letzte 200 Einträge)' },
    { id: 'debug.sessionExpires', type: 'string', role: 'date', name: 'Session-Cookie gültig bis (letzte Erneuerung)' },
    { id: 'debug.lastError', type: 'string', role: 'text', name: 'Letzte Server-Fehlermeldung (io.error)' },
    {
        id: 'debug.serverVersion',
        type: 'string',
        role: 'text',
        name: 'Zuletzt gemeldete Server-Version/Instanz-ID (io.version)',
    },
    // flache Felder des aktuellen Einsatzes
    { id: 'einsatz.alarmAktiv', type: 'boolean', role: 'indicator.alarm', name: 'Alarm aktiv', def: false },
    {
        id: 'einsatz.restzeit',
        type: 'number',
        role: 'value.interval',
        name: 'Restzeit bis Einsatzende',
        unit: 's',
        def: 0,
    },
    { id: 'einsatz.id', type: 'number', role: 'value', name: 'Einsatz ID' },
    { id: 'einsatz.uuid', type: 'string', role: 'text', name: 'Einsatz UUID' },
    { id: 'einsatz.einsatzart', type: 'string', role: 'text', name: 'Einsatzart' },
    { id: 'einsatz.stichwort', type: 'string', role: 'text', name: 'Alarmstichwort' },
    { id: 'einsatz.ort', type: 'string', role: 'text', name: 'Ort' },
    { id: 'einsatz.ortsteil', type: 'string', role: 'text', name: 'Ortsteil' },
    { id: 'einsatz.zeitstempel', type: 'string', role: 'date', name: 'Alarmzeitstempel' },
    { id: 'einsatz.ablaufzeit', type: 'string', role: 'date', name: 'Ablaufzeit' },
    { id: 'einsatz.sondersignal', type: 'number', role: 'value', name: 'Sondersignal', def: 0 },
    { id: 'einsatz.latitude', type: 'number', role: 'value.gps.latitude', name: 'Breitengrad' },
    { id: 'einsatz.longitude', type: 'number', role: 'value.gps.longitude', name: 'Längengrad' },
    // Flache JSON-Objekte/Arrays für Tabellen-Widgets (siehe einsatz.json.*-Channel).
    // Jedes dieser States ist entweder ein flaches Objekt oder ein Array flacher Objekte -
    // bewusst ohne weitere Verschachtelung, da VIS-Tabellen-Widgets nur eine Ebene abflachen
    // können (siehe Diskussion zu den ursprünglich verschachtelten einsatz.json/history10).
    {
        id: 'einsatz.json.current',
        type: 'string',
        role: 'json',
        name: 'Einsatzstamm des aktuellen Einsatzes (JSON-Array mit einem Element, leer falls kein Einsatz aktiv)',
    },
    {
        id: 'einsatz.json.history10',
        type: 'string',
        role: 'json',
        name: `Einsatzstamm der letzten ${HISTORY_SIZE} abgeschlossenen Einsätze, gleiches Schema wie einsatz.json.current (JSON-Array)`,
    },
    {
        id: 'einsatz.json.routen',
        type: 'string',
        role: 'json',
        name: 'Routen des aktuellen Einsatzes, flaches Array (JSON)',
    },
    {
        id: 'einsatz.json.rueckmeldungen',
        type: 'string',
        role: 'json',
        name: 'Rückmeldungen des aktuellen Einsatzes, flaches Array (JSON)',
    },
    {
        id: 'einsatz.json.emAlarmiert',
        type: 'string',
        role: 'json',
        name: 'Alarmierte Einsatzmittel des aktuellen Einsatzes, flaches Array (JSON)',
    },
    {
        id: 'einsatz.json.emWeitere',
        type: 'string',
        role: 'json',
        name: 'Weitere Einsatzmittel des aktuellen Einsatzes, flaches Array (JSON)',
    },
    // abgeleitete Zähler
    { id: 'einsatz.routenGesamt', type: 'number', role: 'value', name: 'Anzahl Routen im aktuellen Einsatz', def: 0 },
    {
        id: 'einsatz.rueckmeldungGesamt',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen gesamt im aktuellen Einsatz',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungAnzahl.ek',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Einsatzkräfte',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungAnzahl.gf',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Gruppenführer',
        def: 0,
    },
    { id: 'einsatz.rueckmeldungAnzahl.zf', type: 'number', role: 'value', name: 'Rückmeldungen: Zugführer', def: 0 },
    {
        id: 'einsatz.rueckmeldungAnzahl.vf',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Verbandsführer',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungAnzahl.agt',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Atemschutzgeräteträger',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungAnzahl.fzf',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Fahrzeugführer',
        def: 0,
    },
    { id: 'einsatz.rueckmeldungAnzahl.ma', type: 'number', role: 'value', name: 'Rückmeldungen: Maschinisten', def: 0 },
    {
        id: 'einsatz.rueckmeldungAnzahl.med',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Medizinisch/Sanitäter',
        def: 0,
    },
    // TTS des aktuellen Einsatzes (Kanal liegt unter einsatz, siehe CHANNEL_DEFS)
    {
        id: 'einsatz.tts.last',
        type: 'string',
        role: 'text.url',
        name: 'Vollständige URL der letzten TTS-Ansage (mp3)',
    },
    { id: 'einsatz.tts.lastTimestamp', type: 'string', role: 'date', name: 'Zeitstempel letzte TTS-Ansage' },
];
// Schneller Zugriff von setField() auf den deklarierten Typ eines States (siehe dort).
const STATE_DEF_BY_ID = new Map(STATE_DEFS.map(def => [def.id, def]));

// IDs, deren "string"-Wert tatsächlich ein JSON-*Array* enthält - liefert den korrekten
// Leerwert "[]" für resetAllStates() (alle anderen "string"-States werden auf null
// gesetzt). einsatz.json.current, debug.lastEvent und debug.normalizedPosition sind
// trotz eines inhaltlich einzelnen Objekts ebenfalls Arrays (mit maximal einem Element)
// - VIS-Tabellen-Widgets erwarten am Root immer ein Array, siehe persistEinsatzSnapshot()
// bzw. die entsprechenden setState()-Aufrufe in handleAlarm()/connect(). einsatz.json.history10
// und debug.monitorAudit stehen ebenfalls hier, obwohl sie nicht bei jedem Neustart
// zurückgesetzt werden (siehe RESET_EXCLUDED_STATE_IDS) - resetAllStates() braucht den
// korrekten Leerwert trotzdem, um sie bei einer frischen Installation zu initialisieren.
const JSON_ARRAY_STATE_IDS = new Set([
    'einsatz.json.current',
    'einsatz.json.routen',
    'einsatz.json.rueckmeldungen',
    'einsatz.json.emAlarmiert',
    'einsatz.json.emWeitere',
    'einsatz.json.history10',
    'debug.monitorAudit',
    'debug.lastEvent',
    'debug.normalizedPosition',
]);

// "number"-States, bei denen 0 ein irreführender "leerer" Wert wäre (Einsatz-ID,
// Koordinaten - 0/0 wäre eine reale, aber falsche Position) - resetAllStates() setzt
// diese auf null statt 0 zurück.
const NULLABLE_NUMBER_STATE_IDS = new Set(['einsatz.id', 'einsatz.latitude', 'einsatz.longitude']);

// States, die resetAllStates() bei einem *bestehenden* Wert bewusst NICHT bei jedem
// Adapter-Start überschreibt - die Historie der letzten Einsätze (einsatz.json.history10)
// und das Verbindungs-/Registrierungs-Audit-Log (debug.monitorAudit) sollen über
// Neustarts hinweg erhalten bleiben. Existiert noch KEIN Wert (frische Installation),
// werden sie trotzdem einmalig initialisiert - siehe initStateIfMissing().
const RESET_EXCLUDED_STATE_IDS = new Set(['einsatz.json.history10', 'debug.monitorAudit']);

/* Prüft ob eine monitorID gültig ist (nicht-leer). */
function isValidMonitor(mon) {
    if (mon === undefined || mon === null) {
        return false;
    }
    return String(mon).trim() !== '';
}

/*
 Robust: akzeptiert Geometry-Objekt oder JSON-String, Feature oder Geometry,
 und handhabt Fälle, in denen geometry.geometry als String kodiert ist.
 Gibt null zurück, wenn keine valide Position gefunden oder 0/0 ermittelt wurde.
*/
function getCenterFromGeometry(g) {
    try {
        if (!g) {
            return null;
        }
        let parsed = g;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch {
                /* leave as string */
            }
        }
        const geomCandidate = parsed?.geometry ?? parsed;
        let geom = geomCandidate;
        if (!geom) {
            return null;
        }
        if (typeof geom === 'string') {
            try {
                geom = JSON.parse(geom);
            } catch {
                /* cannot parse */
            }
        }
        if (!geom || !geom.type || !geom.coordinates) {
            return null;
        }

        const coords = geom.coordinates;
        const collectPoints = (c, type) => {
            const pts = [];
            const pushIfPoint = p => {
                if (!Array.isArray(p) || p.length < 2) {
                    return;
                }
                const lon = Number(p[0]);
                const lat = Number(p[1]);
                if (!isNaN(lat) && !isNaN(lon)) {
                    pts.push([lon, lat]);
                }
            };

            if (type === 'Point') {
                pushIfPoint(c);
            } else if (type === 'LineString' || type === 'MultiPoint') {
                for (const p of c) {
                    pushIfPoint(p);
                }
            } else if (type === 'Polygon') {
                for (const ring of c) {
                    for (const p of ring) {
                        pushIfPoint(p);
                    }
                }
            } else if (type === 'MultiPolygon') {
                for (const poly of c) {
                    for (const ring of poly) {
                        for (const p of ring) {
                            pushIfPoint(p);
                        }
                    }
                }
            } else {
                const flat = Array.isArray(c) ? c.flat(Infinity) : [];
                for (let i = 0; i + 1 < flat.length; i += 2) {
                    const a = Number(flat[i]);
                    const b = Number(flat[i + 1]);
                    if (!isNaN(a) && !isNaN(b)) {
                        pts.push([a, b]);
                    }
                }
            }
            return pts;
        };

        const points = collectPoints(coords, geom.type);
        if (!points || !points.length) {
            return null;
        }

        let minLon = points[0][0];
        let maxLon = points[0][0];
        let minLat = points[0][1];
        let maxLat = points[0][1];
        for (const p of points) {
            if (!Array.isArray(p) || p.length < 2) {
                continue;
            }
            minLon = Math.min(minLon, p[0]);
            maxLon = Math.max(maxLon, p[0]);
            minLat = Math.min(minLat, p[1]);
            maxLat = Math.max(maxLat, p[1]);
        }
        const lat = Number(((minLat + maxLat) / 2).toFixed(6));
        const lon = Number(((minLon + maxLon) / 2).toFixed(6));
        if (lat === 0 && lon === 0) {
            return null;
        }
        return { lat, lon };
    } catch {
        return null;
    }
}

/*
 Normalisiert Payload:
 - priorisiert wgs84_x/wgs84_y (wenn nicht 0/0),
 - akzeptiert data.position falls nicht 0/0,
 - fällt auf geometry (auch stringified) zurück.
 - entfernt roh-geo Felder und setzt position nur, wenn valide.
*/
function normalizeData(obj) {
    try {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }
        const data = JSON.parse(JSON.stringify(obj)); // deep clone
        let center = null;

        if (data.wgs84_x !== undefined && data.wgs84_y !== undefined) {
            // WAIP-Server-Konvention (bestätigt über client_waip.js des offiziellen
            // Frontends: "const lat = data.wgs84_x; const lng = data.wgs84_y;"):
            // wgs84_x = Breitengrad, wgs84_y = Längengrad - NICHT die übliche
            // GIS-Konvention (x=Länge/y=Breite). Absichtlich so übernommen.
            const lat = Number(data.wgs84_x);
            const lon = Number(data.wgs84_y);
            if (!isNaN(lat) && !isNaN(lon) && !(lat === 0 && lon === 0)) {
                center = { lat, lon };
            }
        }

        if (!center && data.position && data.position.lat !== undefined && data.position.lon !== undefined) {
            const latP = Number(data.position.lat);
            const lonP = Number(data.position.lon);
            if (!isNaN(latP) && !isNaN(lonP) && !(latP === 0 && lonP === 0)) {
                center = { lat: latP, lon: lonP };
            }
        }

        if (!center && data.geometry) {
            const c = getCenterFromGeometry(data.geometry);
            if (c) {
                center = c;
            }
        }

        delete data.geometry;
        delete data.wgs84_x;
        delete data.wgs84_y;
        delete data.geojson;
        delete data.geometry_type;

        if (center) {
            data.position = { lat: center.lat, lon: center.lon };
        } else {
            delete data.position;
        }

        return data;
    } catch {
        return obj;
    }
}

/* Dekodiert die auf der /waip/-Übersichtsseite vorkommenden HTML-Entities (teils
   benannt wie &auml;, teils numerisch) und normalisiert Whitespace. Für die dynamische
   Monitor-Auswahl im Admin (siehe fetchMonitorList). */
function decodeHtmlEntities(str) {
    if (!str) {
        return str;
    }
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        auml: 'ä',
        ouml: 'ö',
        uuml: 'ü',
        Auml: 'Ä',
        Ouml: 'Ö',
        Uuml: 'Ü',
        szlig: 'ß',
    };
    return str
        .replace(/&(amp|lt|gt|quot|apos|nbsp|auml|ouml|uuml|Auml|Ouml|Uuml|szlig);/g, m => named[m.slice(1, -1)])
        .replace(/&#(\d+);/g, m => String.fromCodePoint(Number(m.slice(2, -1))))
        .replace(/&#x([0-9a-fA-F]+);/gi, m => String.fromCodePoint(parseInt(m.slice(3, -1), 16)))
        .replace(/\s+/g, ' ')
        .trim();
}

class WaipWeb extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'waip-web',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));

        this.socket = null;
        this.currentMonitor = '';
        this.monitorName = null; // Anzeigename des konfigurierten Monitors, siehe refreshMonitorName()
        this.connecting = false;
        this.registrationPending = false;
        this.registrationTimer = null;
        this.reconnectTimer = null;
        this.restzeitInterval = null;
        this.sessionKeepaliveTimer = null;
        this.nextSessionKeepaliveDelayMs = null;
        this.sessionCookie = null;
        this.currentEinsatzUuid = null;
        this.currentEinsatzSnapshot = null; // -> einsatz.json.current/.routen/.rueckmeldungen/...
        this._restzeitZeroSince = null; // -> Watchdog gegen verpasstes io.standby, siehe restzeitInterval
        this._recurringFailureKeys = new Set(); // -> logRecurringFailure()/logRecovered()
        this._wrongMonitorWindowStart = 0; // -> checkWrongMonitorRate()
        this._wrongMonitorWindowCount = 0;
        this.lastServerVersion = null;

        this._lastDisconnectMsg = null;
        this._lastDisconnectTs = 0;
        this._warnCache = new Map(); // Nachricht -> zuletzt geloggt (ms), siehe safeLog()
        this._lastRestzeit = null;
        this._lastDebugEvent = { event: null, ts: 0 };

        this.HISTORY_SIZE = HISTORY_SIZE;
        this.ALLOWED_EINSATZ_FIELDS = ALLOWED_EINSATZ_FIELDS;
    }

    async onReady() {
        this.REGISTRATION_TIMEOUT_MS = (Number(this.config.registrationTimeoutSec) || 10) * 1000;
        this.RECONNECT_DELAY_MS = (Number(this.config.reconnectDelaySec) || 5) * 1000;
        // Obergrenze für das Session-Keepalive-Intervall - bewusst nicht konfigurierbar,
        // analog zum fest einprogrammierten Wert in /js/session_keepalive.js der Website
        // selbst. Das tatsächliche Intervall wird adaptiv ermittelt (siehe refreshSessionCookie).
        this.SESSION_KEEPALIVE_MS = DEFAULT_SESSION_KEEPALIVE_SEC * 1000;
        this.url = (this.config.url || DEFAULT_URL).trim();
        this.monitorID =
            this.config.monitorID !== undefined && this.config.monitorID !== null
                ? String(this.config.monitorID).trim()
                : '';

        await this.cleanupObsoleteObjects();
        await this.migrateObjectTypes();
        await this.initObjects();
        await this.resetAllStates();
        // Session-Cookie holen, bevor die erste Socket.IO-Verbindung aufgebaut wird
        await this.refreshSessionCookie();
        this.startSessionKeepalive();
        this.startRestzeitInterval();
        // Nicht awaiten - der Alarm-Empfang soll nicht auf diesen (rein informativen)
        // Namens-Lookup warten müssen.
        this.refreshMonitorName().catch(() => {});
        this.connect();
    }

    onUnload(callback) {
        try {
            this.cleanupSocket();
            if (this.registrationTimer) {
                this.clearTimeout(this.registrationTimer);
                this.registrationTimer = null;
            }
            if (this.reconnectTimer) {
                this.clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            if (this.restzeitInterval) {
                this.clearInterval(this.restzeitInterval);
                this.restzeitInterval = null;
            }
            if (this.sessionKeepaliveTimer) {
                this.clearTimeout(this.sessionKeepaliveTimer);
                this.sessionKeepaliveTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    /* Entfernt State-Objekte aus früheren Versionen (vis.*, json.*, geo.*, rueckmeldung.counts.*, ...),
       die durch die Umstrukturierung in 0.4.0 ersetzt wurden. setObjectNotExistsAsync legt neue
       Objekte an, löscht aber nie alte - das übernehmen wir hier einmalig beim Start.
       obj.type === 'state' (nicht obj.common.type, das ist der Werttyp) prüft dabei explizit,
       dass wirklich noch das alte State-Blatt vorliegt - relevant für IDs wie einsatz.json, die
       bei der Umstrukturierung in 0.7.15 von State zu Channel gewechselt sind, aber dieselbe ID
       behalten haben: ohne diese Prüfung würde hier sonst bei jedem Neustart der inzwischen
       längst korrekt angelegte Channel wieder gelöscht und von initObjects() neu erzeugt. */
    async cleanupObsoleteObjects() {
        for (const id of OBSOLETE_OBJECT_IDS) {
            try {
                const obj = await this.getObjectAsync(id);
                if (obj && obj.type === 'state') {
                    await this.delObjectAsync(id);
                    this.log.info(`Removed obsolete state object from a previous version: ${id}`);
                }
            } catch {
                /* ignore - Objekt existierte vermutlich nicht */
            }
        }
    }

    /* Löscht bestehende State-Objekte, deren common.type oder common.role nicht mehr zur
       aktuellen STATE_DEFS-Definition passt (z.B. weil sich herausstellt, dass der Server
       ein Feld als Zahl statt als String schickt - siehe einsatz.id/einsatz.sondersignal
       in 0.4.3 -, oder weil sich eine Rolle als falsch gewählt herausstellt - siehe
       debug.lastError in 0.7.15, das trotz role "json" meist nur einen reinen Fehlertext
       enthält). setObjectNotExistsAsync legt danach in initObjects() ein frisches Objekt
       mit der korrekten Definition an. Generisch für alle künftigen Typ-/Rollen-
       Korrekturen, nicht nur diese. */
    async migrateObjectTypes() {
        for (const def of STATE_DEFS) {
            try {
                const obj = await this.getObjectAsync(def.id);
                if (!obj || !obj.common) {
                    continue;
                }
                const typeChanged = obj.common.type && obj.common.type !== def.type;
                const roleChanged = obj.common.role && obj.common.role !== def.role;
                if (typeChanged || roleChanged) {
                    await this.delObjectAsync(def.id);
                    this.log.info(
                        `Recreated state object with a changed definition: ${def.id} ` +
                            `(type ${obj.common.type} -> ${def.type}, role ${obj.common.role} -> ${def.role})`,
                    );
                }
            } catch {
                /* ignore - Objekt existierte vermutlich noch nicht */
            }
        }
    }

    async initObjects() {
        for (const def of CHANNEL_DEFS) {
            await this.setObjectNotExistsAsync(def.id, {
                type: def.type,
                common: { name: def.name },
                native: {},
            });
        }
        for (const def of STATE_DEFS) {
            await this.setObjectNotExistsAsync(def.id, {
                type: 'state',
                common: {
                    name: def.name,
                    type: def.type,
                    role: def.role,
                    read: true,
                    write: false,
                    unit: def.unit,
                    def: def.def !== undefined ? def.def : null,
                },
                native: {},
            });
        }
    }

    /* Setzt bei jedem Adapter-Start aktiv alle States (außer RESET_EXCLUDED_STATE_IDS) auf
       ihren "leeren" Wert zurück - anders als initObjects()/setObjectNotExistsAsync(), das
       einen bereits vorhandenen Wert unangetastet lässt. Sorgt dafür, dass jeder Neustart
       mit einem sauber initialisierten Zustand beginnt, unabhängig vom Stand davor. Läuft
       nach initObjects(), die States müssen also bereits existieren.
       Für RESET_EXCLUDED_STATE_IDS wird ein *bestehender* Wert nie überschrieben, aber bei
       einer frischen Installation (noch nie ein Wert gesetzt) trotzdem einmalig
       initialisiert - siehe initStateIfMissing(). Sonst bliebe z.B. einsatz.json.history10
       nach der Installation dauerhaft auf null stehen statt auf "[]". */
    async resetAllStates() {
        const tasks = [];
        for (const def of STATE_DEFS) {
            const emptyValue = this.computeEmptyStateValue(def);
            if (RESET_EXCLUDED_STATE_IDS.has(def.id)) {
                tasks.push(this.initStateIfMissing(def.id, emptyValue));
                continue;
            }
            tasks.push(this.setStateAsync(def.id, emptyValue, true));
        }
        const results = await Promise.allSettled(tasks);
        for (const r of results) {
            if (r.status === 'rejected') {
                this.safeWarn('resetAllStates', r.reason);
            }
        }
    }

    /* Liefert den "leeren" Wert, den resetAllStates() für einen State-Def schreibt. */
    computeEmptyStateValue(def) {
        if (def.type === 'boolean') {
            return false;
        }
        if (def.type === 'number') {
            return NULLABLE_NUMBER_STATE_IDS.has(def.id) ? null : 0;
        }
        if (JSON_ARRAY_STATE_IDS.has(def.id)) {
            return '[]';
        }
        return null;
    }

    /* Schreibt emptyValue nur, falls für id noch gar kein State-Wert existiert (frische
       Installation) - lässt einen bereits vorhandenen Wert unangetastet. Für die
       RESET_EXCLUDED_STATE_IDS-Ausnahmen in resetAllStates() genutzt. */
    async initStateIfMissing(id, emptyValue) {
        try {
            const st = await this.getStateAsync(id);
            if (!st || st.val === undefined || st.val === null) {
                await this.setStateAsync(id, emptyValue, true);
            }
        } catch (e) {
            this.safeWarn(`initStateIfMissing ${id}`, e);
        }
    }

    /* Einfacher HTTP(S)-GET ohne zusätzliche Dependency; optional mit Cookie-Header. */
    httpGet(targetUrl, cookie) {
        return new Promise((resolve, reject) => {
            let parsed;
            try {
                parsed = new URL(targetUrl);
            } catch (e) {
                reject(e);
                return;
            }
            const client = parsed.protocol === 'http:' ? http : https;
            const headers = { 'User-Agent': 'ioBroker.waip-web' };
            if (cookie) {
                headers.Cookie = cookie;
            }
            const req = client.get(parsed, { headers, timeout: 15000 }, res => {
                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout')));
        });
    }

    /* Holt die öffentliche Monitor-Übersichtsseite (/waip/) der übergebenen WAIP-Web-
       Instanz und parst daraus die verfügbaren Monitor-IDs für die Admin-Dropdown-Auswahl
       (siehe onMessage/'getMonitorList'). Rein lesend, erfordert keine Session/Cookie. */
    async fetchMonitorList(baseUrl) {
        const clean = String(baseUrl || '').replace(/\/+$/, '');
        if (!clean) {
            throw new Error('no WAIP server URL configured');
        }
        const res = await this.httpGet(`${clean}/waip/`);
        if (res.statusCode !== 200 || !res.body) {
            throw new Error(`Could not fetch monitor overview (status ${res.statusCode})`);
        }
        const html = res.body;

        const LINK_RE = /href="\/waip\/(\d+)"[^>]*>\s*([^<]+?)\s*(?:<|$)/g;
        const extractLinks = section => {
            const out = [];
            let m;
            LINK_RE.lastIndex = 0;
            while ((m = LINK_RE.exec(section))) {
                const label = decodeHtmlEntities(m[2]);
                if (label) {
                    out.push({ value: m[1], label });
                }
            }
            return out;
        };

        // "alle Wachalarme" ist ein eigener Link außerhalb der kategorisierten Listen -
        // wird unabhängig vom Parsing-Erfolg der übrigen Seite immer als erste Option angeboten.
        // Label beginnt jeweils mit der eigentlichen Monitor-ID (z.B. "4 - Leitstelle: Lausitz").
        const result = [{ value: '0', label: '0 - Alle Wachalarme' }];
        const seen = new Set(['0']);

        const headingMatches = [];
        for (const cat of MONITOR_CATEGORY_HEADINGS) {
            const m = cat.re.exec(html);
            if (m) {
                headingMatches.push({ key: cat.key, index: m.index });
            }
        }

        if (headingMatches.length) {
            headingMatches.sort((a, b) => a.index - b.index);
            for (let i = 0; i < headingMatches.length; i++) {
                const start = headingMatches[i].index;
                const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : html.length;
                const sectionLabel = MONITOR_CATEGORY_LABELS[headingMatches[i].key] || headingMatches[i].key;
                for (const link of extractLinks(html.slice(start, end))) {
                    if (!seen.has(link.value)) {
                        seen.add(link.value);
                        result.push({ value: link.value, label: `${link.value} - ${sectionLabel}: ${link.label}` });
                    }
                }
            }
        } else {
            // Keine der bekannten Überschriften gefunden -> gesamte Seite unkategorisiert parsen,
            // damit die Auswahl auch bei abweichend strukturierten WAIP-Web-Instanzen funktioniert.
            for (const link of extractLinks(html)) {
                if (!seen.has(link.value)) {
                    seen.add(link.value);
                    result.push({ value: link.value, label: `${link.value} - ${link.label}` });
                }
            }
        }

        // Nach numerischer Monitor-ID sortiert statt in der (je nach Kategorie/Instanz
        // unterschiedlichen) Reihenfolge der Quellseite - '0' (Alle Wachalarme) landet
        // dabei automatisch an erster Stelle, da alle echten Monitor-IDs größer sind.
        result.sort((a, b) => Number(a.value) - Number(b.value));

        return result;
    }

    /* Löst this.monitorID einmalig zu einem Anzeigenamen ohne ID auf (z.B. "Leitstelle:
       Lausitz" statt "4 - Leitstelle: Lausitz") und schreibt ihn nach status.registered-
       MonitorName. Wird nur einmal beim Start aufgerufen (nicht bei jedem Reconnect) - das
       Ergebnis wird in this.monitorName gecacht und von onSocketConnect() bei jedem
       (Re-)Connect erneut in den State geschrieben, ohne die Übersichtsseite erneut zu holen. */
    async refreshMonitorName() {
        const monStr = isValidMonitor(this.monitorID) ? this.monitorID : '0';
        try {
            const list = await this.fetchMonitorList(this.url);
            const match = list.find(item => item.value === String(monStr));
            this.monitorName = match ? match.label.replace(/^\d+\s*-\s*/, '') : null;
        } catch (e) {
            this.safeLog('debug', 'refreshMonitorName', e);
            this.monitorName = null;
        }
        await this.setField('status.registeredMonitorName', this.monitorName);
    }

    /* Reagiert auf sendTo-Nachrichten aus dem Admin (aktuell nur 'getMonitorList' für das
       dynamische Monitor-Dropdown, siehe admin/jsonConfig.json). */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        if (obj.command === 'getMonitorList') {
            if (!obj.callback) {
                return;
            }
            const targetUrl = (obj.message && obj.message.url) || this.config.url;
            let list;
            try {
                list = await this.fetchMonitorList(targetUrl);
            } catch (e) {
                this.safeLog('debug', 'getMonitorList', e);
                list = [{ value: '0', label: '0 - Alle Wachalarme' }];
            }
            this.sendTo(obj.from, obj.command, list, obj.callback);
        }
    }

    /* Baut aus einem oder mehreren Set-Cookie-Headern einen sendefertigen Cookie-Header (name=value; name2=value2). */
    extractCookieHeader(setCookieHeader) {
        const arr = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
        const pairs = arr.map(c => c.split(';')[0].trim()).filter(Boolean);
        return pairs.length ? pairs.join('; ') : null;
    }

    /*
     Holt bzw. erneuert den Session-Cookie über GET /session/keepalive (rolling session,
     analog zum /js/session_keepalive.js der WAIP-Seite selbst). Ohne aktiven Cookie
     verbindet sich der Socket sonst anonym und die Session läuft ab, wodurch die
     Alarm-Zustellung stoppt.

     Solange die bisherige Session noch gültig ist, liefert der Server denselben
     connect.sid zurück (nur die Ablaufzeit wird verlängert). Ist die alte Session
     serverseitig nicht mehr gültig (z.B. weil der letzte Keepalive-Call die konfigurierte
     Cookie-Laufzeit überschritten hat, oder der Server sie aus anderen Gründen invalidiert
     hat), bekommen wir hier einen NEUEN Cookie-Wert - das wird erkannt (isRotation) und
     meldet dem Aufrufer, ob eine bestehende Socket.IO-Verbindung (die noch mit der alten
     Session verknüpft ist) neu aufgebaut werden sollte.

     Aus der vom Server gemeldeten Ablaufzeit wird außerdem die tatsächliche Cookie-
     Lebensdauer dieser Instanz abgeleitet und in this.nextSessionKeepaliveDelayMs
     abgelegt (siehe scheduleSessionKeepalive) - server/app_cfg.js des WAIP-Web-Projekts
     zeigt, dass die Lebensdauer per ENV konfigurierbar ist (Standard dort: 60s, diese
     Instanz nutzt offenbar 10 Min.), ein fest angenommenes Intervall wäre also für andere
     Instanzen potenziell falsch.
    */
    async refreshSessionCookie() {
        const previousCookie = this.sessionCookie;
        const requestStartedAt = Date.now();
        try {
            const keepaliveUrl = `${this.url}/session/keepalive`;
            const res = await this.httpGet(keepaliveUrl, this.sessionCookie);
            const newCookie = this.extractCookieHeader(res.headers['set-cookie']);
            if (newCookie) {
                const isRotation = !!previousCookie && newCookie !== previousCookie;
                this.sessionCookie = newCookie;
                let expires = null;
                try {
                    expires = JSON.parse(res.body).expires || null;
                } catch {
                    /* ignore, body war kein JSON */
                }
                if (expires) {
                    try {
                        await this.setStateAsync('debug.sessionExpires', expires, true);
                    } catch {
                        /* ignore */
                    }
                    const expiresMs = new Date(expires).getTime();
                    if (!isNaN(expiresMs)) {
                        const observedMaxAgeMs = expiresMs - requestStartedAt;
                        if (observedMaxAgeMs > 0) {
                            // gleiche Klammerung wie /js/session_keepalive.js: 80% der
                            // beobachteten Laufzeit, mindestens SESSION_KEEPALIVE_MIN_MS,
                            // höchstens die konfigurierte Obergrenze (this.SESSION_KEEPALIVE_MS)
                            const ceiling = Math.max(this.SESSION_KEEPALIVE_MS, SESSION_KEEPALIVE_MIN_MS);
                            this.nextSessionKeepaliveDelayMs = Math.min(
                                Math.max(observedMaxAgeMs * 0.8, SESSION_KEEPALIVE_MIN_MS),
                                ceiling,
                            );
                        }
                    }
                }
                if (isRotation) {
                    // Teil des normalen, selbstheilenden Session-Zyklus dieser Instanz
                    // (siehe refreshSessionCookie-Kommentar oben) -> info statt warn.
                    this.log.info(
                        'Session cookie was reissued by the server (old session was invalid) – forcing reconnect',
                    );
                    this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'session_cookie_rotated' }).catch(
                        () => {},
                    );
                } else {
                    this.log.debug(
                        `session cookie renewed (status ${res.statusCode}${expires ? `, valid until ${expires}` : ''}${this.nextSessionKeepaliveDelayMs ? `, next keepalive in ${Math.round(this.nextSessionKeepaliveDelayMs / 1000)}s` : ''})`,
                    );
                }
                this.logRecovered('sessionCookie', 'Session cookie refresh recovered');
                return { ok: true, rotated: isRotation };
            }
            this.logRecurringFailure(
                'sessionCookie',
                'warn',
                'refreshSessionCookie',
                `keepalive response had no Set-Cookie header (status ${res.statusCode})`,
            );
            return { ok: false, rotated: false };
        } catch (e) {
            this.logRecurringFailure('sessionCookie', 'warn', 'refreshSessionCookie', e);
            return { ok: false, rotated: false };
        }
    }

    /* Erzwingt einen Socket-Reconnect, falls gerade eine Verbindung aktiv/im Aufbau ist
       (z.B. weil der Session-Cookie rotiert ist oder der Server laut io.version neu
       gestartet wurde). Läuft gerade kein Socket (z.B. während der Wartezeit vor einem
       geplanten Reconnect), ist nichts zu tun - der nächste connect() erledigt das
       ohnehin mit den dann aktuellen Daten (Cookie etc.). */
    forceReconnect(reason) {
        if (this.connecting) {
            this.log.debug(`forceReconnect(${reason}): connect() is already running, skipping the forced reconnect`);
            return;
        }
        if (!this.socket) {
            this.log.debug(
                `forceReconnect(${reason}): no open connection right now, the next connect() will handle this automatically`,
            );
            return;
        }
        this.log.info(`Rebuilding the Socket.IO connection (${reason})`);
        this.connect(true);
    }

    /* Startet die adaptive Keepalive-Kette. Nutzt this.nextSessionKeepaliveDelayMs, falls
       aus einer vorherigen refreshSessionCookie()-Antwort bereits eine reale Cookie-Laufzeit
       bekannt ist (z.B. aus dem initialen Aufruf in onReady()), sonst die konfigurierte
       Obergrenze als vorsichtigen Startwert. */
    startSessionKeepalive() {
        this.scheduleSessionKeepalive(this.nextSessionKeepaliveDelayMs || this.SESSION_KEEPALIVE_MS);
    }

    /* setTimeout statt setInterval, weil sich das Intervall von Aufruf zu Aufruf ändern
       kann (adaptiv aus der vom Server gemeldeten Cookie-Laufzeit abgeleitet). */
    scheduleSessionKeepalive(delayMs) {
        if (this.sessionKeepaliveTimer) {
            this.clearTimeout(this.sessionKeepaliveTimer);
        }
        this.sessionKeepaliveTimer = this.setTimeout(async () => {
            const { rotated } = await this.refreshSessionCookie();
            if (rotated) {
                this.forceReconnect('session cookie rotated');
            }
            this.scheduleSessionKeepalive(this.nextSessionKeepaliveDelayMs || this.SESSION_KEEPALIVE_MS);
        }, delayMs);
    }

    /* Sicheres, deduplizierendes Logging. level ist 'error'/'warn'/'info'/'debug' -
       je unerwarteter/handlungsbedürftiger ein Fall ist, desto höher das Level.
       safeWarn() bleibt als Kurzform für den (weitaus häufigsten) warn-Fall erhalten.
       Dedupe ist pro Nachricht (nicht nur die zuletzt geloggte) - sonst würden sich
       abwechselnde unterschiedliche Meldungen gegenseitig die Deduplizierung einer
       jeweils wiederkehrenden Meldung verhindern. */
    safeLog(level, context, err) {
        try {
            const now = Date.now();
            const msg = typeof err === 'string' ? err : err && err.message ? err.message : String(err);
            const out = context ? `${context}: ${msg}` : msg;
            const lastLoggedAt = this._warnCache.get(out);
            if (lastLoggedAt !== undefined && now - lastLoggedAt < WARN_DEDUPE_MS) {
                return;
            }
            if (this._warnCache.size >= WARN_DEDUPE_CACHE_MAX) {
                this._warnCache.clear();
            }
            this._warnCache.set(out, now);
            this.log[level](out);
        } catch {
            /* silent */
        }
    }

    safeWarn(context, err) {
        this.safeLog('warn', context, err);
    }

    /* Loggt einen wiederkehrbaren Fehler nach dem offiziellen ioBroker-Logging-Muster
       ("first occurrence at warn/error, repetitions at debug, recovery once at info" -
       siehe Adapter-Entwicklerdoku, Abschnitt "Logging"): beim ersten Auftreten auf
       `level`, bei jedem weiteren (bis zur Erholung via logRecovered()) nur noch auf
       debug. Für tatsächlich wiederkehrende Zustände (Session-Cookie, Registrierung,
       Verbindungsaufbau) gedacht, nicht für einmalige State-Write-Fehler. */
    logRecurringFailure(key, level, context, err) {
        const isFirst = !this._recurringFailureKeys.has(key);
        this._recurringFailureKeys.add(key);
        this.safeLog(isFirst ? level : 'debug', context, err);
    }

    /* Meldet die Erholung von einem zuvor über logRecurringFailure() gemeldeten Fehler -
       loggt einmalig auf info, aber nur falls der Fehler unter diesem key tatsächlich
       aktiv war (sonst kein Log, kein unnötiges Rauschen bei jedem erfolgreichen Versuch). */
    logRecovered(key, msg) {
        if (this._recurringFailureKeys.delete(key)) {
            this.log.info(msg);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: `${key}_recovered` }).catch(() => {});
        }
    }

    /* Dedupliziertes Info-Logging für Disconnects. */
    logDisconnect(msg) {
        try {
            const now = Date.now();
            if (msg === this._lastDisconnectMsg && now - this._lastDisconnectTs < DISCONNECT_DEDUPE_MS) {
                return;
            }
            this._lastDisconnectMsg = msg;
            this._lastDisconnectTs = now;
            this.log.info(msg);
        } catch {
            /* silent */
        }
    }

    /* Hängt einen Eintrag an das Monitor-Audit-Log an (max. 200 Einträge). */
    async appendMonitorAudit(entry) {
        try {
            const st = await this.getStateAsync('debug.monitorAudit');
            let arr = [];
            try {
                arr = st && st.val ? JSON.parse(st.val) : [];
            } catch {
                arr = [];
            }
            arr.unshift(entry);
            if (arr.length > 200) {
                arr = arr.slice(0, 200);
            }
            await this.setStateAsync('debug.monitorAudit', JSON.stringify(arr), true);
        } catch (e) {
            // betrifft nur das interne Audit-Log, keine echten Einsatzdaten -> debug statt warn
            this.safeLog('debug', 'appendMonitorAudit', e);
        }
    }

    incrementIgnoredCount() {
        this.getStateAsync('debug.ignoredCount')
            .then(c => this.setStateAsync('debug.ignoredCount', Number((c && c.val) || 0) + 1, true))
            .catch(() => {});
    }

    /* Eskaliert wiederholte "Event für anderen Monitor"-Meldungen auf warn, wenn sie
       innerhalb eines Zeitfensters (WRONG_MONITOR_WARN_WINDOW_MS) einen Schwellwert
       (WRONG_MONITOR_WARN_THRESHOLD) überschreiten - Hinweis auf eine falsch
       konfigurierte Monitor-ID, statt dauerhaft nur auf info zu bleiben. Nutzt
       logRecurringFailure()/logRecovered() für das übliche warn-einmal/debug-danach/
       info-bei-Erholung-Muster. */
    checkWrongMonitorRate() {
        const now = Date.now();
        if (now - this._wrongMonitorWindowStart > WRONG_MONITOR_WARN_WINDOW_MS) {
            // Fenster abgelaufen, ohne dass es nochmal den Schwellwert erreicht hat ->
            // falls zuvor eskaliert wurde, gilt die Rate jetzt als erholt.
            this.logRecovered('wrongMonitor', 'Wrong-monitor event rate returned to normal');
            this._wrongMonitorWindowStart = now;
            this._wrongMonitorWindowCount = 0;
        }
        this._wrongMonitorWindowCount++;
        if (this._wrongMonitorWindowCount >= WRONG_MONITOR_WARN_THRESHOLD) {
            this.logRecurringFailure(
                'wrongMonitor',
                'warn',
                'ignoredEvent.wrongMonitor',
                `Repeatedly receiving events for a different monitor (current=${this.currentMonitor}, ` +
                    `${this._wrongMonitorWindowCount} in the last ${Math.round(WRONG_MONITOR_WARN_WINDOW_MS / 60000)}min) ` +
                    `- check the configured monitor ID`,
            );
        }
    }

    /* Setzt einen State; Objekte/Arrays werden JSON-stringifiziert. */
    async setField(path, val) {
        try {
            let toSet;
            const def = STATE_DEF_BY_ID.get(path);
            if (val === null) {
                toSet = null;
            } else if (def && def.type === 'string') {
                // Der State ist als "string" deklariert (z.B. role "json") - unabhängig vom
                // tatsächlichen JS-Typ der Serverantwort (etwa ein rohes Boolean/Number-Flag)
                // muss "val" den deklarierten Typ einhalten, sonst schlägt die
                // ioBroker-Objektstrukturprüfung fehl (E3005).
                toSet = typeof val === 'string' ? val : JSON.stringify(val);
            } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
                toSet = val;
            } else {
                toSet = JSON.stringify(val);
            }
            await this.setStateAsync(path, toSet, true);
        } catch (e) {
            this.safeWarn(`setField ${path}`, e);
        }
    }

    /* Schreibt ein flaches Array (routen/rueckmeldungen/emAlarmiert/emWeitere) in einen
       einsatz.json.*-State. Wandelt Nicht-Arrays defensiv in ein leeres Array um, damit
       Tabellen-Widgets nie auf einen unerwarteten Werttyp treffen. */
    async writeJsonArrayState(id, value) {
        try {
            await this.setStateAsync(id, JSON.stringify(Array.isArray(value) ? value : []), true);
        } catch (e) {
            this.safeWarn(`${id}.setState`, e);
        }
    }

    /* Löst das verschachtelte position-Objekt eines Routen-Eintrags zu flachen lat/lon-Feldern
       auf (siehe einsatz.json.routen) - Tabellen-Widgets können nur eine Verschachtelungsebene
       abflachen, position{lat,lon} wäre bereits eine Ebene zu viel. */
    flattenRoutenEntry(r) {
        if (!r || typeof r !== 'object') {
            return r;
        }
        const { position, ...rest } = r;
        return {
            ...rest,
            lat: position && typeof position.lat === 'number' ? position.lat : null,
            lon: position && typeof position.lon === 'number' ? position.lon : null,
        };
    }

    /* Extrahiert aus einem Einsatz-Snapshot nur die flachen Einsatzstamm-Felder
       (ALLOWED_EINSATZ_FIELDS + lat/lon aus position), ergänzt um den zum Aufrufzeitpunkt
       registrierten Monitor - ohne routen/rueckmeldungen/emAlarmiert/emWeitere. Gemeinsam
       genutzt von persistEinsatzSnapshot() (einsatz.json.current) und
       pushEinsatzToHistory() (einsatz.json.history10), damit beide garantiert dasselbe
       Schema haben. registeredMonitor/registeredMonitorName machen bei history10
       nachvollziehbar, auf welchen Monitor der Adapter zum Zeitpunkt des jeweiligen
       Einsatzes konfiguriert war (kann sich über die Zeit ändern) - bei current sind sie
       redundant zu status.registeredMonitor/.registeredMonitorName, aber harmlos, da
       beide Schemas identisch bleiben sollen. */
    buildFlatEinsatzJson(snapshot) {
        const src = snapshot || {};
        const flat = {};
        for (const k of this.ALLOWED_EINSATZ_FIELDS) {
            flat[k] = Object.prototype.hasOwnProperty.call(src, k) ? src[k] : null;
        }
        flat.lat = src.position && typeof src.position.lat === 'number' ? src.position.lat : null;
        flat.lon = src.position && typeof src.position.lon === 'number' ? src.position.lon : null;
        flat.registeredMonitor = this.currentMonitor || null;
        flat.registeredMonitorName = this.monitorName || null;
        return flat;
    }

    /* Löst eine vom Server per io.playtts gesendete TTS-URL zu einer vollständigen absoluten
       URL auf. Bereits absolute URLs (http(s)://...) bleiben unverändert, relative Pfade
       (z.B. "/tts/xyz.mp3") werden mit der konfigurierten WAIP-Server-URL zusammengesetzt. */
    resolveTtsUrl(raw) {
        if (typeof raw !== 'string' || !raw) {
            return raw;
        }
        if (/^https?:\/\//i.test(raw)) {
            return raw;
        }
        const base = (this.url || '').replace(/\/+$/, '');
        const path = raw.startsWith('/') ? raw : `/${raw}`;
        return `${base}${path}`;
    }

    /* Prüft ob eine eingehende Payload eindeutig einem Monitor zuordenbar ist und mit currentMonitor übereinstimmt. */
    payloadMonitorMatch(p) {
        if (!p || typeof p !== 'object') {
            return null;
        }
        const keys = [
            'monitor',
            'monitorID',
            'monitor_id',
            'monitorId',
            'waip_monitor',
            'waip_monitor_id',
            'wache_nr',
            'wache_id',
            'wacheId',
            'room',
            'tenant',
            'group',
        ];
        for (const k of keys) {
            if (p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== '') {
                const val = String(p[k]).trim();
                if (val === String(this.currentMonitor)) {
                    return true;
                }
                if (
                    !isNaN(Number(val)) &&
                    !isNaN(Number(this.currentMonitor)) &&
                    Number(val) === Number(this.currentMonitor)
                ) {
                    return true;
                }
                return false;
            }
        }
        return null; // no monitor-identifying field found
    }

    /*
     Handler-Wrapper: prüft Monitor-Match bevor der eigentliche Handler ausgeführt wird.

     WICHTIG (siehe client_waip.js des offiziellen Frontends): Die Monitor-Zuordnung
     passiert vollständig serverseitig über eine Socket.IO-Room-Registrierung
     (ausgelöst durch emit('WAIP', monitorId) in onSocketConnect). Kein einziges
     reales Event (io.new_waip/io.new_rmld/io.routes/io.playtts/io.standby) trägt ein
     eigenes Monitor-Kennungsfeld im Payload - das offizielle Frontend prüft beim
     Empfang auch gar nichts. payloadMonitorMatch() liefert für reale Payloads daher
     praktisch immer null.

     Frühere Version verwarf Events ohne Monitor-Feld nach Ablauf des Registrierungs-
     Timeouts als "unknownMonitor" - das hat bei jeder nicht-globalen Monitor-ID (≠ '0')
     die komplette Alarm-Zustellung nach dem Timeout stillschweigend gestoppt. Jetzt
     gilt: jedes empfangene Event bestätigt die Registrierung und wird verarbeitet,
     außer das Payload nennt EXPLIZIT eine andere Monitor-Kennung (match === false).
    */
    wrapHandlerWithMonitorCheck(handler) {
        return payload => {
            try {
                const match = this.payloadMonitorMatch(payload);

                if (match === false) {
                    // Reine, erwartete Filterlogik (kein Fehler) - Häufigkeit ist über
                    // debug.ignoredCount messbar; checkWrongMonitorRate() eskaliert bei
                    // dauerhaft hoher Anzahl auf warn (Hinweis auf falsch konfigurierte
                    // Monitor-ID), bleibt sonst bei info.
                    this.safeLog(
                        'info',
                        'ignoredEvent.wrongMonitor',
                        `Received an event for a different monitor (current=${this.currentMonitor})`,
                    );
                    this.incrementIgnoredCount();
                    this.checkWrongMonitorRate();
                    return;
                }

                // match === true (Monitor-Feld passt) oder match === null (kein
                // Monitor-Feld im Payload, der Normalfall) -> Registrierung bestätigt.
                if (this.registrationPending || match === true) {
                    this.setState('status.registrationAccepted', true, true);
                    this.setState('status.registeredMonitor', this.currentMonitor, true);
                    if (this.registrationTimer) {
                        this.clearTimeout(this.registrationTimer);
                        this.registrationTimer = null;
                    }
                    this.registrationPending = false;
                    this.setState('status.registrationPending', false, true);
                    this.logRecovered('registration', 'WAIP registration recovered');
                }

                try {
                    handler(payload);
                } catch (e) {
                    // Ein empfangenes Event konnte nicht verarbeitet werden -> echter
                    // Datenverlust, daher error statt warn.
                    this.safeLog('error', 'handler.exec', e);
                }
            } catch (e) {
                this.safeLog('error', 'wrapHandlerWithMonitorCheck', e);
            }
        };
    }

    /* Schreibt this.currentEinsatzSnapshot komplett (inkl. verschachtelter Arrays) nach einsatz.json. */
    async persistEinsatzSnapshot() {
        try {
            const flat = this.buildFlatEinsatzJson(this.currentEinsatzSnapshot);
            // Als Array mit einem Element speichern (nicht das nackte Objekt) - VIS-Tabellen-
            // Widgets erwarten am Root immer ein Array, sonst liefern sie keine Zeile.
            await this.setStateAsync('einsatz.json.current', JSON.stringify([flat]), true);
        } catch (e) {
            this.safeWarn('persistEinsatzSnapshot', e);
        }
    }

    /* Legt den aktuellen Einsatz-Snapshot als abgeschlossenen Eintrag vorne in einsatz.json.history10 ab
       (z.B. bei io.standby oder wenn ein neuer Einsatz beginnt, ohne dass zuvor io.standby kam).
       Dedupliziert über die uuid, damit derselbe Einsatz nicht doppelt eingetragen wird, falls
       sowohl io.standby als auch der nächste io.new_waip diese Methode auslösen. */
    async pushEinsatzToHistory() {
        try {
            if (!this.currentEinsatzSnapshot || !this.currentEinsatzSnapshot.uuid) {
                return;
            }
            const st = await this.getStateAsync('einsatz.json.history10');
            let arr = [];
            try {
                arr = st && st.val ? JSON.parse(st.val) : [];
            } catch {
                arr = [];
            }
            if (arr.length && arr[0] && arr[0].uuid === this.currentEinsatzSnapshot.uuid) {
                return;
            }
            // Nur den flachen Einsatzstamm archivieren - Routen/Rückmeldungen/Alarmierungen
            // gelten nur für den jeweils aktuellen Einsatz und werden nicht historisiert.
            arr.unshift(this.buildFlatEinsatzJson(this.currentEinsatzSnapshot));
            if (arr.length > this.HISTORY_SIZE) {
                arr = arr.slice(0, this.HISTORY_SIZE);
            }
            await this.setStateAsync('einsatz.json.history10', JSON.stringify(arr), true);
        } catch (e) {
            this.safeWarn('pushEinsatzToHistory', e);
        }
    }

    /* Berechnet aus den im Snapshot gesammelten Rückmeldungen die Zähler pro Rolle/Fähigkeit
       (analog zu den Badges EK/GF/ZF/VF/AGT/FZF/MA/MED/Gesamt der Weboberfläche) und
       aktualisiert einsatz.rueckmeldungAnzahl.* sowie einsatz.rueckmeldungGesamt. */
    async updateRueckmeldungCounts() {
        const list = (this.currentEinsatzSnapshot && this.currentEinsatzSnapshot.rueckmeldungen) || [];
        const counts = { ek: 0, gf: 0, zf: 0, vf: 0, agt: 0, fzf: 0, ma: 0, med: 0 };
        for (const r of list) {
            if (r.rmld_role === 'team_member') {
                counts.ek++;
            } else if (r.rmld_role === 'crew_leader') {
                counts.gf++;
            } else if (r.rmld_role === 'division_chief') {
                counts.zf++;
            } else if (r.rmld_role === 'group_commander') {
                counts.vf++;
            }
            if (Number(r.rmld_capability_agt) > 0) {
                counts.agt++;
            }
            if (Number(r.rmld_capability_fzf) > 0) {
                counts.fzf++;
            }
            if (Number(r.rmld_capability_ma) > 0) {
                counts.ma++;
            }
            if (Number(r.rmld_capability_med) > 0) {
                counts.med++;
            }
        }
        const tasks = RUECKMELDUNG_ANZAHL_KEYS.map(k =>
            this.setStateAsync(`einsatz.rueckmeldungAnzahl.${k}`, counts[k], true),
        );
        tasks.push(this.setStateAsync('einsatz.rueckmeldungGesamt', list.length, true));
        const results = await Promise.allSettled(tasks);
        for (const r of results) {
            if (r.status === 'rejected') {
                this.safeWarn('updateRueckmeldungCounts', r.reason);
            }
        }
    }

    /* Handler für eingehende Alarme (io.new_waip). */
    async handleAlarm(incoming) {
        try {
            try {
                await this.setStateAsync('debug.rawPayloadShort', JSON.stringify(incoming).slice(0, 500), true);
            } catch {
                /* ignore */
            }

            const data = normalizeData(incoming || {});
            try {
                // Flach halten (lat/lon statt eines verschachtelten position-Objekts) und als
                // Array mit einem Element speichern (nicht das nackte Objekt) - VIS-Tabellen-
                // Widgets erwarten am Root immer ein Array, sonst liefern sie keine Zeile.
                await this.setStateAsync(
                    'debug.normalizedPosition',
                    JSON.stringify([
                        {
                            lat: data.position && typeof data.position.lat === 'number' ? data.position.lat : null,
                            lon: data.position && typeof data.position.lon === 'number' ? data.position.lon : null,
                        },
                    ]),
                    true,
                );
            } catch {
                /* ignore */
            }

            // Neuer Einsatz (andere uuid als der aktuell verfolgte) -> vorherigen Snapshot (falls
            // noch nicht per io.standby archiviert) sichern und mit leeren Listen neu beginnen.
            // Bei einer bloßen Aktualisierung desselben Einsatzes (gleiche uuid, z.B. Korrektur
            // der Besonderheiten) bleiben bereits erfasste Routen/Rückmeldungen bewusst erhalten -
            // anders als die Live-Webseite, die bei JEDEM io.new_waip zurücksetzt.
            const isNewEinsatz = data.uuid && data.uuid !== this.currentEinsatzUuid;
            if (isNewEinsatz) {
                await this.pushEinsatzToHistory();
                this.currentEinsatzUuid = data.uuid;
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
                // Sofort leeren statt auf das nächste io.routes/io.new_rmld für den neuen
                // Einsatz zu warten - sonst zeigen diese States/Zähler bis dahin noch die
                // Routen/Rückmeldungen des alten Einsatzes (z.B. relevant, wenn zwischen
                // beiden Einsätzen ein io.standby verpasst wurde). einsatz.json.current und
                // .emAlarmiert/.emWeitere werden weiter unten in dieser Methode ohnehin
                // unbedingt neu geschrieben, brauchen hier keine gesonderte Behandlung.
                await this.writeJsonArrayState('einsatz.json.routen', []);
                await this.writeJsonArrayState('einsatz.json.rueckmeldungen', []);
                try {
                    await this.setStateAsync('einsatz.routenGesamt', 0, true);
                } catch (e) {
                    this.safeWarn('einsatz.routenGesamt.setState', e);
                }
                await this.updateRueckmeldungCounts();
            } else if (!this.currentEinsatzSnapshot) {
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
            }

            let lat = null;
            let lon = null;
            if (data.position && data.position.lat !== undefined && data.position.lon !== undefined) {
                lat = Number(data.position.lat);
                lon = Number(data.position.lon);
            }

            if (lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon)) {
                try {
                    await this.setStateAsync('einsatz.latitude', lat, true);
                } catch (e) {
                    this.safeWarn('einsatz.latitude.setState', e);
                }
                try {
                    await this.setStateAsync('einsatz.longitude', lon, true);
                } catch (e) {
                    this.safeWarn('einsatz.longitude.setState', e);
                }
                this.currentEinsatzSnapshot.position = { lat, lon };
            } else {
                try {
                    await this.setStateAsync('einsatz.latitude', null, true);
                } catch {
                    /* ignore */
                }
                try {
                    await this.setStateAsync('einsatz.longitude', null, true);
                } catch {
                    /* ignore */
                }
                this.currentEinsatzSnapshot.position = null;
            }

            try {
                await this.setStateAsync('einsatz.alarmAktiv', true, true);
            } catch (e) {
                this.safeWarn('einsatz.alarmAktiv.setState', e);
            }

            // flache Felder setzen und gleichzeitig im Snapshot mitführen
            const tasks = [];
            for (const k of this.ALLOWED_EINSATZ_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(data, k)) {
                    this.currentEinsatzSnapshot[k] = data[k];
                    tasks.push(this.setField(`einsatz.${k}`, data[k]));
                }
            }
            if (data.em_alarmiert !== undefined) {
                this.currentEinsatzSnapshot.emAlarmiert = data.em_alarmiert;
            }
            if (data.em_weitere !== undefined) {
                this.currentEinsatzSnapshot.emWeitere = data.em_weitere;
            }

            const results = await Promise.allSettled(tasks);
            for (const r of results) {
                if (r.status === 'rejected') {
                    this.safeWarn('handleAlarm.setFields', r.reason);
                }
            }

            await this.persistEinsatzSnapshot();
            await this.writeJsonArrayState('einsatz.json.emAlarmiert', this.currentEinsatzSnapshot.emAlarmiert);
            await this.writeJsonArrayState('einsatz.json.emWeitere', this.currentEinsatzSnapshot.emWeitere);
        } catch (e) {
            // Ein Alarm-Event konnte nicht verarbeitet werden -> echter Datenverlust.
            this.safeLog('error', 'handleAlarm', e);
        }
    }

    /* Handler für Rückmeldungen (io.new_rmld). Werden im Snapshot des aktuellen Einsatzes
       gesammelt (dedupliziert über rmld_uuid) statt in einem separaten "letzte Rückmeldung"-State. */
    async handleRueckmeldung(incoming) {
        try {
            const data = normalizeData(incoming || {});

            if (!this.currentEinsatzSnapshot) {
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
            }
            if (!Array.isArray(this.currentEinsatzSnapshot.rueckmeldungen)) {
                this.currentEinsatzSnapshot.rueckmeldungen = [];
            }

            // Rückmeldungen für einen anderen (alten) Einsatz nicht mit aufnehmen.
            if (data.waip_uuid && this.currentEinsatzUuid && data.waip_uuid !== this.currentEinsatzUuid) {
                this.log.debug(
                    `Ignoring feedback for a different incident ${data.waip_uuid} (current=${this.currentEinsatzUuid})`,
                );
                return;
            }

            const list = this.currentEinsatzSnapshot.rueckmeldungen;
            if (data.rmld_uuid) {
                const idx = list.findIndex(r => r.rmld_uuid === data.rmld_uuid);
                if (idx >= 0) {
                    list[idx] = data;
                } else {
                    list.push(data);
                }
            } else {
                list.push(data);
            }

            await this.persistEinsatzSnapshot();
            await this.writeJsonArrayState('einsatz.json.rueckmeldungen', this.currentEinsatzSnapshot.rueckmeldungen);
            await this.updateRueckmeldungCounts();
        } catch (e) {
            // Eine Rückmeldung konnte nicht verarbeitet werden -> echter Datenverlust.
            this.safeLog('error', 'handleRueckmeldung', e);
        }
    }

    /* Handler für Standby (io.standby) - Einsatz beendet / Monitor im Ruhezustand.
       Analog zum offiziellen Frontend (client_waip.js leert dabei Stichwort, Ortsdaten,
       Besonderheiten etc. und setzt die Karte zurück): der abgeschlossene Einsatz wird
       zuerst archiviert (einsatz.json.history10), danach werden alle auf den aktuellen Einsatz
       bezogenen States geleert - so bleibt alarmAktiv ein verlässlicher Schalter dafür, ob
       einsatz.* gerade echte Live-Daten enthält, statt still den letzten (beendeten)
       Einsatz weiter anzuzeigen. */
    /* Schließt den aktuellen Einsatz ab: alarmAktiv=false, Archivierung nach
       einsatz.json.history10, Leeren aller einsatz.*-States. Gemeinsam genutzt von einem
       echten io.standby (handleStandby()) und vom Watchdog in restzeitInterval, falls
       io.standby verpasst wurde (siehe dort). */
    async finalizeCurrentEinsatz() {
        try {
            await this.setStateAsync('einsatz.alarmAktiv', false, true);
        } catch (e) {
            this.safeWarn('einsatz.alarmAktiv.setState', e);
        }
        await this.pushEinsatzToHistory();
        await this.clearCurrentEinsatzStates();
        this._restzeitZeroSince = null;
    }

    async handleStandby() {
        try {
            this.log.info('Standby received - incident ended, or monitor idle');
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'standby' }).catch(() => {});
            await this.finalizeCurrentEinsatz();
        } catch (e) {
            // Standby konnte nicht verarbeitet werden -> Historie/States ggf. inkonsistent.
            this.safeLog('error', 'handleStandby', e);
        }
    }

    /* Leert alle States, die sich auf den aktuellen (jetzt beendeten) Einsatz beziehen -
       flache einsatz.*-Felder, einsatz.json.current/.routen/.rueckmeldungen/.emAlarmiert/
       .emWeitere sowie alle abgeleiteten Zähler. Wird nach pushEinsatzToHistory() aufgerufen,
       der abgeschlossene Einsatz bleibt also weiterhin über einsatz.json.history10 abrufbar. */
    async clearCurrentEinsatzStates() {
        const tasks = this.ALLOWED_EINSATZ_FIELDS.map(k => this.setStateAsync(`einsatz.${k}`, null, true));
        tasks.push(this.setStateAsync('einsatz.latitude', null, true));
        tasks.push(this.setStateAsync('einsatz.longitude', null, true));
        tasks.push(this.writeJsonArrayState('einsatz.json.current', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.routen', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.rueckmeldungen', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.emAlarmiert', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.emWeitere', []));
        tasks.push(this.setStateAsync('einsatz.routenGesamt', 0, true));
        const results = await Promise.allSettled(tasks);
        for (const r of results) {
            if (r.status === 'rejected') {
                this.safeWarn('clearCurrentEinsatzStates', r.reason);
            }
        }

        this.currentEinsatzUuid = null;
        this.currentEinsatzSnapshot = null;
        // rueckmeldungGesamt/rueckmeldungAnzahl.* liest aus this.currentEinsatzSnapshot,
        // ist jetzt also null -> alle Zähler werden konsistent auf 0 zurückgesetzt.
        await this.updateRueckmeldungCounts();
    }

    /* Handler für Server-Fehlermeldungen (io.error). Das bekannte "Fehler beim Erneuern
       der Session"-Muster gehört zum normalen, selbstheilenden ~10-Minuten-Session-Zyklus
       dieser Instanz (Reconnect erfolgt automatisch über refreshSessionCookie/forceReconnect)
       und wird deshalb nur als info geloggt. Alle anderen, unbekannten io.error-Inhalte
       bleiben warn, da dort nicht bekannt ist, ob sie folgenlos sind. */
    async handleServerError(data) {
        try {
            const msg = typeof data === 'string' ? data : JSON.stringify(data);
            const isKnownSessionRenewalError = /Fehler beim Erneuern der Session/i.test(msg);
            this.safeLog(isKnownSessionRenewalError ? 'info' : 'warn', 'io.error (Server)', msg);
            await this.setField('debug.lastError', data);
        } catch {
            /* ignore */
        }
    }

    /* Handler für io.version - Server-Identität/Version. Ändert sich die vom Server
       gemeldete ID zur Laufzeit, ist der Server vermutlich neu gestartet (das offizielle
       Frontend lädt in diesem Fall die Seite komplett neu). Laut server/auth.js des
       WAIP-Web-Projekts werden Sessions persistent (SQLite) gespeichert, ein Neustart
       löscht sie also normalerweise NICHT automatisch - trotzdem ist ein Server-Neustart
       ein guter genereller Anlass, Cookie und Verbindung vorsorglich aufzufrischen (billige
       Absicherung gegen jede Art von serverseitiger Zustandsänderung, nicht nur Sessions). */
    async handleServerVersion(serverId) {
        try {
            await this.setStateAsync('debug.serverVersion', String(serverId), true);
            if (this.lastServerVersion && this.lastServerVersion !== serverId) {
                // Wird bereits automatisch behandelt (Session-Refresh + Reconnect) ->
                // kein Handlungsbedarf, daher info statt warn.
                this.log.info(
                    `WAIP server reports a new version/instance ID (${this.lastServerVersion} -> ${serverId}) - likely a server restart`,
                );
                this.appendMonitorAudit({
                    ts: new Date().toISOString(),
                    event: 'server_version_changed',
                    from: this.lastServerVersion,
                    to: serverId,
                }).catch(() => {});
                this.lastServerVersion = serverId;
                await this.refreshSessionCookie();
                this.forceReconnect('server version changed');
                return;
            }
            this.lastServerVersion = serverId;
        } catch (e) {
            this.safeWarn('handleServerVersion', e);
        }
    }

    /* Handler für Routen (io.routes). Routen sind der aktuell gültige Satz für den laufenden
       Einsatz (wird bei jedem Event ersetzt, nicht akkumuliert) und liegt daher als Array
       innerhalb von einsatz.json.routen[]. */
    async handleRoutes(incoming) {
        try {
            let data = incoming;
            if (Array.isArray(incoming)) {
                data = incoming.map(i => normalizeData(i));
            } else if (typeof incoming === 'object' && incoming !== null) {
                data = normalizeData(incoming);
            }

            if (!this.currentEinsatzSnapshot) {
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
            }
            this.currentEinsatzSnapshot.routen = Array.isArray(data) ? data : data ? [data] : [];

            await this.persistEinsatzSnapshot();
            await this.writeJsonArrayState(
                'einsatz.json.routen',
                this.currentEinsatzSnapshot.routen.map(r => this.flattenRoutenEntry(r)),
            );
            try {
                await this.setStateAsync('einsatz.routenGesamt', this.currentEinsatzSnapshot.routen.length, true);
            } catch (e) {
                this.safeWarn('einsatz.routenGesamt.setState', e);
            }
        } catch (e) {
            // Ein Routen-Event konnte nicht verarbeitet werden -> echter Datenverlust.
            this.safeLog('error', 'handleRoutes', e);
        }
    }

    /* Handler für TTS-Events (io.playtts). Payload ist laut client_waip.js nur eine URL
       (direkt als audio.src verwendet) - im Browser funktioniert das auch als relativer
       Pfad, weil er implizit gegen die aktuelle Seiten-Origin aufgelöst wird. Für uns nicht
       (VIS/Automationen haben nicht zwangsläufig dieselbe Origin wie der WAIP-Server),
       daher wird hier explizit zu einer vollständigen absoluten URL aufgelöst. */
    async handleTTS(incoming) {
        try {
            const data = normalizeData(incoming || {});
            const ts = new Date().toISOString();
            await this.setField('einsatz.tts.last', this.resolveTtsUrl(data));
            await this.setField('einsatz.tts.lastTimestamp', ts);
        } catch (e) {
            // Ein TTS-Event konnte nicht verarbeitet werden -> echter Datenverlust.
            this.safeLog('error', 'handleTTS', e);
        }
    }

    /* Cleanup helper: schließt und entfernt eine vorhandene socket-Instanz vollständig. */
    cleanupSocket() {
        // Nur wenn tatsächlich ein Socket existierte, ist auch initObjects() bereits
        // gelaufen (this.socket wird ausschließlich in connect() gesetzt, das erst nach
        // initObjects() läuft) - sonst könnte onUnload() (ruft cleanupSocket() unbedingt
        // auf) die States unten setzen, bevor deren Objekte überhaupt angelegt wurden,
        // z.B. bei einem sehr schnellen Neustart der Instanz kurz nach der Installation.
        const hadSocket = !!this.socket;
        try {
            if (!this.socket) {
                return;
            }
            try {
                this.socket.removeAllListeners();
            } catch {
                /* ignore */
            }
            try {
                this.socket.disconnect();
            } catch {
                /* ignore */
            }
            try {
                if (typeof this.socket.close === 'function') {
                    this.socket.close();
                }
            } catch {
                /* ignore */
            }
        } catch (e) {
            // Reines Aufräumen der alten Socket-Instanz, kein Datenverlust -> debug statt warn.
            this.safeLog('debug', 'cleanupSocket', e);
        } finally {
            this.socket = null;
            this.connecting = false;
            this.registrationPending = false;
            if (hadSocket) {
                this.setState('status.registrationPending', false, true);
            }
            if (this.registrationTimer) {
                this.clearTimeout(this.registrationTimer);
                this.registrationTimer = null;
            }
        }
    }

    onSocketConnect(monStr) {
        this.connecting = false;
        this.setState('status.connected', true, true);
        this.setState('info.connection', true, true);
        this.logRecovered('connection', 'Socket.IO connection recovered');

        try {
            // Ein einzelner Emit reicht: Socket.IO liefert ab einem bestehenden 'connect'
            // bereits zuverlässig zu, und ein echter Verbindungsabbruch wird ohnehin über
            // onSocketDisconnect()/onSocketConnectError() samt Reconnect (und damit einem
            // frischen Emit) abgefangen. Bleibt die Registrierung trotzdem unbestätigt,
            // greift REGISTRATION_TIMEOUT_MS weiter unten als Sicherheitsnetz. Frühere
            // Versionen emittierten hier 3× - das führte nur dazu, dass der Server bei
            // jedem (redundanten) Emit erneut mit dem aktuellen Status antwortete
            // (io.standby/io.new_waip), ohne einen zusätzlichen Zuverlässigkeitsgewinn.
            this.log.info(`socket.emit('WAIP', ${monStr})`);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'emit_WAIP', value: monStr }).catch(
                () => {},
            );
            this.socket.emit('WAIP', monStr);
        } catch (e) {
            this.logRecurringFailure('registration', 'warn', 'socket.emit.WAIP', e);
        }

        this.registrationPending = true;
        this.setState('status.registeredMonitor', monStr, true);
        // Gecachter Anzeigename (siehe refreshMonitorName) - keine erneute HTTP-Abfrage
        // bei jedem (Re-)Connect, ist ggf. beim allerersten Connect noch null.
        this.setState('status.registeredMonitorName', this.monitorName, true);
        this.setState('status.registrationAccepted', false, true);
        this.setState('status.registrationPending', true, true);
        if (this.registrationTimer) {
            this.clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
        }
        this.registrationTimer = this.setTimeout(async () => {
            this.registrationPending = false;
            this.setState('status.registrationPending', false, true);
            const accState = await this.getStateAsync('status.registrationAccepted');
            const acc = accState ? accState.val : null;
            if (acc !== true) {
                await this.setStateAsync('status.registrationAccepted', false, true);
                this.logRecurringFailure(
                    'registration',
                    'warn',
                    'onSocketConnect',
                    `WAIP registration for monitor ${this.currentMonitor} not confirmed within ${this.REGISTRATION_TIMEOUT_MS}ms`,
                );
                this.appendMonitorAudit({
                    ts: new Date().toISOString(),
                    event: 'registration_timeout',
                    monitor: this.currentMonitor,
                }).catch(() => {});
            }
            this.registrationTimer = null;
        }, this.REGISTRATION_TIMEOUT_MS);

        this.log.info(`Connected monitor ${monStr} -> namespace /waip (registered via WAIP emit)`);
    }

    onSocketDisconnect(reason) {
        this.connecting = false;
        this.setState('status.connected', false, true);
        this.setState('info.connection', false, true);
        this.logDisconnect(`Socket disconnected: ${reason}`);
        this.registrationPending = false;
        this.setState('status.registrationAccepted', false, true);
        this.setState('status.registrationPending', false, true);
        if (this.registrationTimer) {
            this.clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
        }

        this.cleanupSocket();
        this.reconnectTimer = this.setTimeout(() => {
            this.log.info(`manual reconnect triggered for monitor '${this.currentMonitor}'`);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'manual_reconnect_triggered' }).catch(
                () => {},
            );
            this.connect();
        }, this.RECONNECT_DELAY_MS);
    }

    onSocketConnectError(err) {
        this.connecting = false;
        this.setState('status.connected', false, true);
        this.setState('info.connection', false, true);
        // War zuvor doppelt geloggt (safeWarn zusätzlich zu logDisconnect für dasselbe
        // Event) - logDisconnect() unten reicht aus.
        this.logDisconnect(`connect_error: ${String(err)}`);
        this.cleanupSocket();
        this.reconnectTimer = this.setTimeout(() => {
            this.log.info(`manual reconnect after connect_error for monitor '${this.currentMonitor}'`);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'manual_reconnect_after_error' }).catch(
                () => {},
            );
            this.connect();
        }, this.RECONNECT_DELAY_MS);
    }

    /*
     Connect: verbindet zur socket.io-namespace '/waip' (über path '/socket.io'),
     registriert sich per emit('WAIP', monitor).

     WICHTIG: automatische reconnects deaktiviert (reconnection: false). Nach
     disconnect/connect_error wird manuell reconnect() nach RECONNECT_DELAY_MS aufgerufen.
    */
    async connect(force = false) {
        try {
            const monStr = isValidMonitor(this.monitorID) ? this.monitorID : '0';

            if (!force && this.socket && this.currentMonitor === monStr && !this.connecting) {
                this.log.debug(`connect(): already connected to monitor ${monStr}, skipping`);
                return;
            }

            // Falls (z.B. nach einem längeren Disconnect) noch kein/kein frischer
            // Session-Cookie vorliegt, vor dem (Re-)Connect einen holen.
            if (!this.sessionCookie) {
                await this.refreshSessionCookie();
            }

            this.cleanupSocket();
            this.connecting = true;
            this.currentMonitor = monStr;

            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'connect_called', using: monStr }).catch(
                () => {},
            );
            this.log.info(`connect(): using monitor '${monStr}'`);

            const namespaceUrl = `${this.url}/waip`;
            this.socket = io(namespaceUrl, {
                path: '/socket.io',
                forceNew: true,
                transports: ['websocket', 'polling'],
                reconnection: false,
                timeout: 20000,
                query: { monitor: monStr },
                // Session-Cookie mitschicken, damit die Verbindung nicht anonym/ohne
                // Server-Session läuft (siehe refreshSessionCookie/startSessionKeepalive)
                extraHeaders: this.sessionCookie ? { Cookie: this.sessionCookie } : undefined,
            });

            try {
                if (this.socket && this.socket.io && this.socket.io.engine) {
                    const eng = this.socket.io.engine;
                    this.log.debug(`engine pingInterval=${eng.pingInterval} pingTimeout=${eng.pingTimeout}`);
                    // ping/pong/open/close wiederholen sich für die gesamte Verbindungsdauer
                    // (alle pingInterval ms) ohne diagnostischen Mehrwert nach den ersten paar -
                    // deshalb hier begrenzt, anders als die Message-Preview darunter (jeweils
                    // anderer Inhalt, seltener, bleibt bewusst unbegrenzt).
                    let enginePingPongLogCount = 0;
                    eng.on('packet', pkt => {
                        try {
                            if (pkt && pkt.type) {
                                if (['ping', 'pong', 'open', 'close'].includes(String(pkt.type))) {
                                    if (enginePingPongLogCount < 10) {
                                        enginePingPongLogCount++;
                                        this.log.debug(`engine.packet: ${JSON.stringify(pkt)}`);
                                    }
                                } else if (pkt.data && typeof pkt.data === 'string') {
                                    const preview = pkt.data.length > 200 ? `${pkt.data.slice(0, 200)}...` : pkt.data;
                                    this.log.debug(`engine.packet.message preview: ${preview}`);
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    });
                }
            } catch {
                /* ignore */
            }

            this.socket.on('connect', () => this.onSocketConnect(monStr));
            this.socket.on('disconnect', reason => this.onSocketDisconnect(reason));
            this.socket.on('connect_error', err => this.onSocketConnectError(err));

            // Diagnostik: erste eingehende Rohdaten als Preview loggen (max. 6 Events)
            let firstCount = 0;
            const anyListener = (event, ...args) => {
                try {
                    firstCount++;
                    const previewArgs =
                        args && args.length
                            ? typeof args[0] === 'string'
                                ? args[0].slice(0, 500)
                                : JSON.stringify(args[0]).slice(0, 500)
                            : '';
                    this.log.debug(`incoming event '${event}' preview: ${previewArgs}`);
                    if (firstCount >= 6 && this.socket && typeof this.socket.offAny === 'function') {
                        try {
                            this.socket.offAny(anyListener);
                        } catch {
                            /* ignore */
                        }
                    }
                } catch {
                    /* ignore */
                }
            };
            try {
                if (this.socket && typeof this.socket.onAny === 'function') {
                    this.socket.onAny(anyListener);
                }
            } catch {
                /* ignore */
            }

            this.socket.on('io.new_waip', this.wrapHandlerWithMonitorCheck(this.handleAlarm.bind(this)));
            this.socket.on('io.new_rmld', this.wrapHandlerWithMonitorCheck(this.handleRueckmeldung.bind(this)));
            this.socket.on('io.routes', this.wrapHandlerWithMonitorCheck(this.handleRoutes.bind(this)));
            this.socket.on('io.playtts', this.wrapHandlerWithMonitorCheck(this.handleTTS.bind(this)));
            this.socket.on('io.standby', this.wrapHandlerWithMonitorCheck(this.handleStandby.bind(this)));
            // io.error/io.version sind serverweite, nicht monitor-gebundene Signale ->
            // bewusst ohne wrapHandlerWithMonitorCheck registriert.
            this.socket.on('io.error', data => this.handleServerError(data));
            this.socket.on('io.version', serverId => this.handleServerVersion(serverId));

            this.socket.onAny((event, ...args) => {
                try {
                    const now = Date.now();
                    if (event !== this._lastDebugEvent.event || now - this._lastDebugEvent.ts > 5000) {
                        this._lastDebugEvent = { event, ts: now };
                        // Als Array mit einem Element speichern (nicht das nackte Objekt) -
                        // VIS-Tabellen-Widgets erwarten am Root immer ein Array, sonst liefern
                        // sie keine Zeile.
                        this.setField('debug.lastEvent', [
                            {
                                event,
                                ts: new Date().toISOString(),
                                argsCount: args.length,
                            },
                        ]).catch(() => {});
                    }
                } catch {
                    /* ignore */
                }
            });
        } catch (e) {
            this.logRecurringFailure('connection', 'warn', 'connect', e);
            this.connecting = false;
        }
    }

    /* Intervall: Restzeit bis Einsatzende. */
    startRestzeitInterval() {
        this.restzeitInterval = this.setInterval(async () => {
            let rest = 0;
            try {
                const s = await this.getStateAsync('einsatz.ablaufzeit');
                if (s && s.val !== undefined && s.val !== null && s.val !== '') {
                    const end = new Date(s.val);
                    if (!isNaN(end.getTime())) {
                        rest = Math.max(0, Math.floor((end.getTime() - Date.now()) / 1000));
                    }
                }
            } catch {
                rest = 0;
            }
            await this.updateRestzeit(rest);
            await this.checkMissedStandby(rest);
        }, 1000);
    }

    /* Watchdog gegen ein verpasstes io.standby: steht einsatz.restzeit seit
       MISSED_STANDBY_GRACE_MS auf 0, obwohl noch ein Einsatz als aktiv geführt wird, wird
       angenommen, dass io.standby verpasst wurde (z.B. durch einen Disconnect zum
       falschen Zeitpunkt) - der Einsatz wird dann automatisch abgeschlossen, statt
       unbegrenzt mit veralteten Daten als "aktiv" stehen zu bleiben. */
    async checkMissedStandby(rest) {
        if (rest > 0 || !this.currentEinsatzUuid || !this.currentEinsatzSnapshot) {
            this._restzeitZeroSince = null;
            return;
        }
        if (this._restzeitZeroSince === null) {
            this._restzeitZeroSince = Date.now();
            return;
        }
        if (Date.now() - this._restzeitZeroSince < MISSED_STANDBY_GRACE_MS) {
            return;
        }
        const einsatzUuid = this.currentEinsatzUuid;
        this.log.warn(
            `Likely missed io.standby detected (ablaufzeit exceeded by more than ${Math.round(
                MISSED_STANDBY_GRACE_MS / 1000,
            )}s) - finalizing incident ${einsatzUuid} automatically.`,
        );
        this.appendMonitorAudit({
            ts: new Date().toISOString(),
            event: 'missed_standby_timeout',
            einsatz: einsatzUuid,
        }).catch(() => {});
        await this.finalizeCurrentEinsatz();
    }

    async updateRestzeit(rest) {
        if (this._lastRestzeit !== rest) {
            this._lastRestzeit = rest;
            try {
                await this.setStateAsync('einsatz.restzeit', rest, true);
            } catch {
                /* ignore */
            }
        }
    }
}

if (require.main !== module) {
    module.exports = options => new WaipWeb(options);
} else {
    new WaipWeb();
}
