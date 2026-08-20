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
 * Objektstruktur (Stand 0.4.0): Rückmeldungen und Routen sind pro Einsatz
 * Listen (1:n) und liegen deshalb als verschachtelte JSON-Arrays innerhalb
 * von einsatz.json bzw. jedem Eintrag von einsatz.history10 - ergänzt um
 * schnell bindbare Zähler (einsatz.routenGesamt, einsatz.rueckmeldungGesamt,
 * einsatz.rueckmeldungAnzahl.*). Der frühere vis.*-Kanal entfällt komplett.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
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
const ALLOWED_EINSATZ_FIELDS = [
    'id',
    'uuid',
    'einsatzart',
    'stichwort',
    'ort',
    'ortsteil',
    'ablaufzeit',
    'sondersignal',
    // laut client_waip.js (offizielles Frontend) zusätzlich vorhandene Felder:
    'zeitstempel',
    'einsatznummer',
    'objekt',
    'objektteil',
    'strasse',
    'hausnummer',
    'einsatzdetails',
    'besonderheiten',
    'permissions',
];
const RUECKMELDUNG_ANZAHL_KEYS = ['ek', 'gf', 'zf', 'vf', 'agt', 'fzf', 'ma', 'med'];
const DISCONNECT_DEDUPE_MS = 60000; // suppress identical disconnect logs for 60s
const WARN_DEDUPE_MS = 5000;

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
    { id: 'status.alarmAktiv', type: 'boolean', role: 'indicator.alarm', name: 'Alarm aktiv', def: false },
    {
        id: 'status.restzeit',
        type: 'number',
        role: 'value.interval',
        name: 'Restzeit bis Einsatzende',
        unit: 's',
        def: 0,
    },
    { id: 'status.registeredMonitor', type: 'string', role: 'text', name: 'Aktuell registrierte Monitor-ID' },
    {
        id: 'status.registrationAccepted',
        type: 'mixed',
        role: 'indicator',
        name: 'Registrierung bestätigt (true/false/pending)',
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
    { id: 'debug.lastError', type: 'string', role: 'json', name: 'Letzte Server-Fehlermeldung (io.error)' },
    {
        id: 'debug.serverVersion',
        type: 'string',
        role: 'text',
        name: 'Zuletzt gemeldete Server-Version/Instanz-ID (io.version)',
    },
    // flache Felder des aktuellen Einsatzes
    { id: 'einsatz.id', type: 'number', role: 'value', name: 'Einsatz ID' },
    { id: 'einsatz.uuid', type: 'string', role: 'text', name: 'Einsatz UUID' },
    { id: 'einsatz.einsatzart', type: 'string', role: 'text', name: 'Einsatzart' },
    { id: 'einsatz.stichwort', type: 'string', role: 'text', name: 'Alarmstichwort' },
    { id: 'einsatz.ort', type: 'string', role: 'text', name: 'Ort' },
    { id: 'einsatz.ortsteil', type: 'string', role: 'text', name: 'Ortsteil' },
    { id: 'einsatz.strasse', type: 'string', role: 'text', name: 'Straße' },
    { id: 'einsatz.hausnummer', type: 'string', role: 'text', name: 'Hausnummer' },
    { id: 'einsatz.objekt', type: 'string', role: 'text', name: 'Objekt' },
    { id: 'einsatz.objektteil', type: 'string', role: 'text', name: 'Objektteil' },
    { id: 'einsatz.einsatzdetails', type: 'string', role: 'text', name: 'Einsatzdetails' },
    { id: 'einsatz.besonderheiten', type: 'string', role: 'text', name: 'Besonderheiten' },
    { id: 'einsatz.zeitstempel', type: 'string', role: 'date', name: 'Alarmzeitstempel' },
    { id: 'einsatz.ablaufzeit', type: 'string', role: 'date', name: 'Ablaufzeit' },
    { id: 'einsatz.einsatznummer', type: 'string', role: 'text', name: 'Einsatznummer' },
    { id: 'einsatz.sondersignal', type: 'number', role: 'value', name: 'Sondersignal', def: 0 },
    { id: 'einsatz.permissions', type: 'mixed', role: 'json', name: 'Berechtigungs-Flag der Registrierung' },
    { id: 'einsatz.latitude', type: 'number', role: 'value.gps.latitude', name: 'Breitengrad' },
    { id: 'einsatz.longitude', type: 'number', role: 'value.gps.longitude', name: 'Längengrad' },
    // verschachteltes Gesamtobjekt + Historie
    {
        id: 'einsatz.json',
        type: 'string',
        role: 'json',
        name: 'Vollständiger aktueller Einsatz inkl. Einsatzmittel/Routen/Rückmeldungen (JSON)',
    },
    {
        id: 'einsatz.history10',
        type: 'string',
        role: 'json',
        name: `Letzte ${HISTORY_SIZE} abgeschlossene Einsätze, gleicher Objekt-Shape wie einsatz.json (JSON-Array)`,
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
    // TTS
    { id: 'tts.last', type: 'string', role: 'json', name: 'Letzte TTS-Ansage (JSON)' },
    { id: 'tts.lastTimestamp', type: 'string', role: 'date', name: 'Zeitstempel letzte TTS-Ansage' },
    { id: 'tts.history10', type: 'string', role: 'json', name: `Letzte ${HISTORY_SIZE} TTS-Ansagen (JSON-Array)` },
];

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

class WaipWeb extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'waip-web',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.socket = null;
        this.currentMonitor = '';
        this.connecting = false;
        this.registrationPending = false;
        this.registrationTimer = null;
        this.reconnectTimer = null;
        this.restzeitInterval = null;
        this.sessionKeepaliveTimer = null;
        this.nextSessionKeepaliveDelayMs = null;
        this.sessionCookie = null;
        this.currentEinsatzUuid = null;
        this.currentEinsatzSnapshot = null; // verschachteltes Objekt -> einsatz.json
        this.ttsHistory = [];
        this.lastServerVersion = null;

        this._lastDisconnectMsg = null;
        this._lastDisconnectTs = 0;
        this._warnCache = { lastMsg: null, ts: 0 };
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
        // Session-Cookie holen, bevor die erste Socket.IO-Verbindung aufgebaut wird
        await this.refreshSessionCookie();
        this.startSessionKeepalive();
        this.startRestzeitInterval();
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
       Objekte an, löscht aber nie alte - das übernehmen wir hier einmalig beim Start. */
    async cleanupObsoleteObjects() {
        for (const id of OBSOLETE_OBJECT_IDS) {
            try {
                const obj = await this.getObjectAsync(id);
                if (obj) {
                    await this.delObjectAsync(id);
                    this.log.info(`Veraltetes State-Objekt aus vorheriger Version entfernt: ${id}`);
                }
            } catch {
                /* ignore - Objekt existierte vermutlich nicht */
            }
        }
    }

    /* Löscht bestehende State-Objekte, deren common.type nicht mehr zur aktuellen
       STATE_DEFS-Definition passt (z.B. weil sich herausstellt, dass der Server ein Feld
       als Zahl statt als String schickt - siehe einsatz.id/einsatz.sondersignal in 0.4.3).
       setObjectNotExistsAsync legt danach in initObjects() ein frisches Objekt mit dem
       korrekten Typ an. Generisch für alle künftigen Typ-Korrekturen, nicht nur diese. */
    async migrateObjectTypes() {
        for (const def of STATE_DEFS) {
            try {
                const obj = await this.getObjectAsync(def.id);
                if (obj && obj.common && obj.common.type && obj.common.type !== def.type) {
                    await this.delObjectAsync(def.id);
                    this.log.info(
                        `State-Objekt mit geändertem Datentyp neu angelegt: ${def.id} (${obj.common.type} -> ${def.type})`,
                    );
                }
            } catch {
                /* ignore - Objekt existierte vermutlich noch nicht */
            }
        }
    }

    async initObjects() {
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
                    this.log.warn(
                        'Session-Cookie wurde vom Server neu ausgestellt (alte Session war ungültig) – erzwinge Reconnect',
                    );
                    this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'session_cookie_rotated' }).catch(
                        () => {},
                    );
                } else {
                    this.log.debug(
                        `session cookie erneuert (status ${res.statusCode}${expires ? `, gültig bis ${expires}` : ''}${this.nextSessionKeepaliveDelayMs ? `, nächstes Keepalive in ${Math.round(this.nextSessionKeepaliveDelayMs / 1000)}s` : ''})`,
                    );
                }
                return { ok: true, rotated: isRotation };
            }
            this.safeWarn(
                'refreshSessionCookie',
                `keepalive lieferte keinen Set-Cookie-Header (status ${res.statusCode})`,
            );
            return { ok: false, rotated: false };
        } catch (e) {
            this.safeWarn('refreshSessionCookie', e);
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
            this.log.debug(`forceReconnect(${reason}): connect() läuft bereits, überspringe erzwungenen Reconnect`);
            return;
        }
        if (!this.socket) {
            this.log.debug(
                `forceReconnect(${reason}): aktuell keine offene Verbindung, nächster connect() erledigt das automatisch`,
            );
            return;
        }
        this.log.info(`Baue Socket.IO-Verbindung neu auf (${reason})`);
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
                this.forceReconnect('Session-Cookie rotiert');
            }
            this.scheduleSessionKeepalive(this.nextSessionKeepaliveDelayMs || this.SESSION_KEEPALIVE_MS);
        }, delayMs);
    }

    /* Sicheres, deduplizierendes Warn-Logging. */
    safeWarn(context, err) {
        try {
            const now = Date.now();
            const msg = typeof err === 'string' ? err : err && err.message ? err.message : String(err);
            const out = context ? `${context}: ${msg}` : msg;
            if (out === this._warnCache.lastMsg && now - this._warnCache.ts < WARN_DEDUPE_MS) {
                return;
            }
            this._warnCache.lastMsg = out;
            this._warnCache.ts = now;
            this.log.warn(out);
        } catch {
            /* silent */
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
            this.safeWarn('appendMonitorAudit', e);
        }
    }

    incrementIgnoredCount() {
        this.getStateAsync('debug.ignoredCount')
            .then(c => this.setStateAsync('debug.ignoredCount', Number((c && c.val) || 0) + 1, true))
            .catch(() => {});
    }

    /* Setzt einen State; Objekte/Arrays werden JSON-stringifiziert. */
    async setField(path, val) {
        try {
            let toSet;
            if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
                toSet = val;
            } else {
                toSet = JSON.stringify(val);
            }
            await this.setStateAsync(path, toSet, true);
        } catch (e) {
            this.safeWarn(`setField ${path}`, e);
        }
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
                    this.safeWarn(
                        'ignoredEvent.wrongMonitor',
                        `Event für anderen Monitor empfangen (current=${this.currentMonitor})`,
                    );
                    this.incrementIgnoredCount();
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
                }

                try {
                    handler(payload);
                } catch (e) {
                    this.safeWarn('handler.exec', e);
                }
            } catch (e) {
                this.safeWarn('wrapHandlerWithMonitorCheck', e);
            }
        };
    }

    /* Schreibt this.currentEinsatzSnapshot komplett (inkl. verschachtelter Arrays) nach einsatz.json. */
    async persistEinsatzSnapshot() {
        try {
            await this.setStateAsync('einsatz.json', JSON.stringify(this.currentEinsatzSnapshot), true);
        } catch (e) {
            this.safeWarn('persistEinsatzSnapshot', e);
        }
    }

    /* Legt den aktuellen Einsatz-Snapshot als abgeschlossenen Eintrag vorne in einsatz.history10 ab
       (z.B. bei io.standby oder wenn ein neuer Einsatz beginnt, ohne dass zuvor io.standby kam).
       Dedupliziert über die uuid, damit derselbe Einsatz nicht doppelt eingetragen wird, falls
       sowohl io.standby als auch der nächste io.new_waip diese Methode auslösen. */
    async pushEinsatzToHistory() {
        try {
            if (!this.currentEinsatzSnapshot || !this.currentEinsatzSnapshot.uuid) {
                return;
            }
            const st = await this.getStateAsync('einsatz.history10');
            let arr = [];
            try {
                arr = st && st.val ? JSON.parse(st.val) : [];
            } catch {
                arr = [];
            }
            if (arr.length && arr[0] && arr[0].uuid === this.currentEinsatzSnapshot.uuid) {
                return;
            }
            arr.unshift(this.currentEinsatzSnapshot);
            if (arr.length > this.HISTORY_SIZE) {
                arr = arr.slice(0, this.HISTORY_SIZE);
            }
            await this.setStateAsync('einsatz.history10', JSON.stringify(arr), true);
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
                this.safeWarn('Rückmeldung-Zähler setzen', r.reason);
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
                await this.setStateAsync(
                    'debug.normalizedPosition',
                    JSON.stringify({ position: data.position ?? null }),
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
                await this.setStateAsync('status.alarmAktiv', true, true);
            } catch (e) {
                this.safeWarn('status.alarmAktiv.setState', e);
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
                    this.safeWarn('Einsatz-Feld setzen', r.reason);
                }
            }

            await this.persistEinsatzSnapshot();
        } catch (e) {
            this.safeWarn('handleAlarm', e);
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
                    `Rückmeldung für abweichenden Einsatz ${data.waip_uuid} ignoriert (aktuell=${this.currentEinsatzUuid})`,
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
            await this.updateRueckmeldungCounts();
        } catch (e) {
            this.safeWarn('handleRueckmeldung', e);
        }
    }

    /* Handler für Standby (io.standby) - Einsatz beendet / Monitor im Ruhezustand.
       Die zuletzt bekannten Einsatzdaten (einsatz.*, einsatz.json, Zähler) bleiben bewusst
       stehen, bis ein neuer Einsatz eintrifft - nur alarmAktiv wird zurückgesetzt. */
    async handleStandby() {
        try {
            this.log.info('Standby empfangen - Einsatz beendet bzw. Monitor im Ruhezustand');
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'standby' }).catch(() => {});
            try {
                await this.setStateAsync('status.alarmAktiv', false, true);
            } catch (e) {
                this.safeWarn('status.alarmAktiv.setState', e);
            }
            await this.pushEinsatzToHistory();
        } catch (e) {
            this.safeWarn('handleStandby', e);
        }
    }

    /* Handler für Server-Fehlermeldungen (io.error). */
    async handleServerError(data) {
        try {
            this.safeWarn('io.error (Server)', typeof data === 'string' ? data : JSON.stringify(data));
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
                this.log.warn(
                    `WAIP-Server meldet neue Version/Instanz-ID (${this.lastServerVersion} -> ${serverId}) - vermutlich Server-Neustart`,
                );
                this.appendMonitorAudit({
                    ts: new Date().toISOString(),
                    event: 'server_version_changed',
                    from: this.lastServerVersion,
                    to: serverId,
                }).catch(() => {});
                this.lastServerVersion = serverId;
                await this.refreshSessionCookie();
                this.forceReconnect('Server-Version geändert');
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
            try {
                await this.setStateAsync('einsatz.routenGesamt', this.currentEinsatzSnapshot.routen.length, true);
            } catch (e) {
                this.safeWarn('einsatz.routenGesamt.setState', e);
            }
        } catch (e) {
            this.safeWarn('handleRoutes', e);
        }
    }

    /* Handler für TTS-Events (io.playtts). Payload ist laut client_waip.js nur eine URL
       (direkt als audio.src verwendet), daher kein Einsatzbezug/keine weiteren Felder. */
    async handleTTS(incoming) {
        try {
            const data = normalizeData(incoming || {});
            const ts = new Date().toISOString();
            await this.setField('tts.last', data);
            await this.setField('tts.lastTimestamp', ts);

            if (!Array.isArray(this.ttsHistory)) {
                this.ttsHistory = [];
            }
            this.ttsHistory.unshift({ zeitstempel: ts, url: data });
            if (this.ttsHistory.length > this.HISTORY_SIZE) {
                this.ttsHistory = this.ttsHistory.slice(0, this.HISTORY_SIZE);
            }
            try {
                await this.setStateAsync('tts.history10', JSON.stringify(this.ttsHistory), true);
            } catch (e) {
                this.safeWarn('tts.history10.setState', e);
            }
        } catch (e) {
            this.safeWarn('handleTTS', e);
        }
    }

    /* Cleanup helper: schließt und entfernt eine vorhandene socket-Instanz vollständig. */
    cleanupSocket() {
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
            this.safeWarn('cleanupSocket', e);
        } finally {
            this.socket = null;
            this.connecting = false;
            this.registrationPending = false;
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

        try {
            this.log.info(`socket.emit('WAIP', ${monStr}) [1/3]`);
            this.appendMonitorAudit({
                ts: new Date().toISOString(),
                event: 'emit_WAIP',
                value: monStr,
                attempt: 1,
            }).catch(() => {});
            this.socket.emit('WAIP', monStr);
        } catch (e) {
            this.safeWarn('socket.emit.WAIP', e);
        }

        this.setTimeout(() => {
            try {
                this.log.debug(`socket.emit('WAIP', ${monStr}) [2/3]`);
                this.appendMonitorAudit({
                    ts: new Date().toISOString(),
                    event: 'emit_WAIP',
                    value: monStr,
                    attempt: 2,
                }).catch(() => {});
                if (this.socket) {
                    this.socket.emit('WAIP', monStr);
                }
            } catch (e) {
                this.safeWarn('socket.emit.WAIP.2', e);
            }
        }, 1000);

        this.setTimeout(() => {
            try {
                this.log.debug(`socket.emit('WAIP', ${monStr}) [3/3]`);
                this.appendMonitorAudit({
                    ts: new Date().toISOString(),
                    event: 'emit_WAIP',
                    value: monStr,
                    attempt: 3,
                }).catch(() => {});
                if (this.socket) {
                    this.socket.emit('WAIP', monStr);
                }
            } catch (e) {
                this.safeWarn('socket.emit.WAIP.3', e);
            }
        }, 3000);

        this.registrationPending = true;
        this.setState('status.registeredMonitor', monStr, true);
        this.setState('status.registrationAccepted', 'pending', true);
        if (this.registrationTimer) {
            this.clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
        }
        this.registrationTimer = this.setTimeout(async () => {
            this.registrationPending = false;
            const accState = await this.getStateAsync('status.registrationAccepted');
            const acc = accState ? accState.val : null;
            if (acc !== true) {
                await this.setStateAsync('status.registrationAccepted', false, true);
                this.log.warn(
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

        this.log.info(`Verbunden Monitor ${monStr} -> namespace /waip (registered via WAIP emit)`);
    }

    onSocketDisconnect(reason) {
        this.connecting = false;
        this.setState('status.connected', false, true);
        this.setState('info.connection', false, true);
        this.logDisconnect(`Socket disconnected: ${reason}`);
        this.registrationPending = false;
        this.setState('status.registrationAccepted', false, true);
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
        this.safeWarn('connect_error', err);
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
                    eng.on('packet', pkt => {
                        try {
                            if (pkt && pkt.type) {
                                if (['ping', 'pong', 'open', 'close'].includes(String(pkt.type))) {
                                    this.log.debug(`engine.packet: ${JSON.stringify(pkt)}`);
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
                        this.setField('debug.lastEvent', {
                            event,
                            ts: new Date().toISOString(),
                            argsCount: args.length,
                        }).catch(() => {});
                    }
                } catch {
                    /* ignore */
                }
            });
        } catch (e) {
            this.safeWarn('connect', e);
            this.connecting = false;
        }
    }

    /* Intervall: Restzeit bis Einsatzende. */
    startRestzeitInterval() {
        this.restzeitInterval = this.setInterval(async () => {
            try {
                const s = await this.getStateAsync('einsatz.ablaufzeit');
                if (!s || s.val === undefined || s.val === null || s.val === '') {
                    await this.updateRestzeit(0);
                    return;
                }
                const end = new Date(s.val);
                if (isNaN(end.getTime())) {
                    await this.updateRestzeit(0);
                    return;
                }
                const rest = Math.max(0, Math.floor((end.getTime() - Date.now()) / 1000));
                await this.updateRestzeit(rest);
            } catch {
                await this.updateRestzeit(0);
            }
        }, 1000);
    }

    async updateRestzeit(rest) {
        if (this._lastRestzeit !== rest) {
            this._lastRestzeit = rest;
            try {
                await this.setStateAsync('status.restzeit', rest, true);
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
