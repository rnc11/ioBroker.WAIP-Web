![Logo](admin/waip-web-logo.png)

# ioBroker.waip-web

[![NPM version](https://img.shields.io/npm/v/iobroker.waip-web.svg)](https://www.npmjs.com/package/iobroker.waip-web)
[![Downloads](https://img.shields.io/npm/dm/iobroker.waip-web.svg)](https://www.npmjs.com/package/iobroker.waip-web)
![Number of Installations (latest)](https://iobroker.live/badges/waip-web-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/waip-web-stable.svg)
[![Test and Release](https://github.com/rnc11/ioBroker.waip-web/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/rnc11/ioBroker.waip-web/actions/workflows/test-and-release.yml)
[![Translation status](https://weblate.iobroker.net/widgets/adapters/-/waip-web/svg-badge.svg)](https://weblate.iobroker.net/engage/adapters/?utm_source=widget)
[![License](https://img.shields.io/npm/l/iobroker.waip-web.svg)](LICENSE)

🇩🇪 [Deutsche Version dieser README](README.de.md)

Unofficial ioBroker adapter for **Wachalarm IP-Web (WAIP-Web)**

Connects via Socket.IO to a WAIP-Web dispatch monitor and mirrors incidents
("Einsatz"), responder feedback ("Rückmeldung"), routes and TTS
announcements into ioBroker states – without needing a browser tab to stay
open.

## Table of contents

- [About this adapter](#about-this-adapter)
- [About WAIP-Web](#about-waip-web)
- [Practical use cases](#practical-use-cases)
- [Features](#features)
  - [Why a session cookie is needed](#why-a-session-cookie-is-needed)
- [Configuration](#configuration)
- [States (under `waip-web.0.*`)](#states-under-waip-web0)
  - [info](#info) · [status](#status) · [einsatz](#einsatz) ·
    [einsatz.json](#einsatzjson) · [einsatz.tts](#einsatztts) ·
    [debug](#debug)
- [Logging](#logging)
- [Changelog](#changelog)
- [License](#license)

## About this adapter

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

## About WAIP-Web

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

## Practical use cases

This section is about what you can actually *build* with the states this
adapter provides – typical use in a fire station/EMS environment:

- **Wall-mounted alarm display.** Bind `einsatz.json.current` to a VIS
  table widget on a wall-mounted tablet or TV in the day room/vehicle
  hall – incident type, keyword, address and alerted resources appear
  automatically, without anyone having to keep a browser tab open on that
  screen (which is the whole reason this adapter exists in the first
  place).
- **Trigger automations the instant an alarm comes in.** Watch
  `einsatz.alarmAktiv` (or `info.connection` together with it) in a
  script/blockly rule to switch on lights in the vehicle hall, open a
  gate/door, send a push notification (e.g. via a Telegram/Pushover
  adapter) with `einsatz.stichwort` + `einsatz.ort`, or flash a
  smart-light scene – all a few seconds after the actual pager alert,
  no polling required since ioBroker state changes fire instantly.
- **Announce the alarm out loud.** `einsatz.tts.last` is a ready-to-play
  absolute mp3 URL; point a `sonos`/`snapcast`/`text2speech`-style
  automation at it (or just play the URL directly) to have the incident
  announced over building speakers the moment `io.playtts` fires –
  useful where members aren't all looking at a screen.
- **Live headcount / feedback board.** The `einsatz.rueckmeldungAnzahl.*`
  counters (per role: EK/GF/ZF/VF, per qualification: AGT/FZF/MA/MED)
  update in real time as responders confirm via the app – bind them to
  gauge or number widgets for an at-a-glance "who's coming" overview
  during the response.
- **Post-incident review / statistics.** `einsatz.json.history10` keeps
  the last 10 completed incidents as a flat table – bind it to a second
  VIS view or export it periodically (e.g. via a script reading the
  state on `io.standby`) to keep a longer-running log or feed incident
  counts into a dashboard/statistics adapter.
- **Route/vehicle overview on a map.** `einsatz.json.routen` carries
  each responding station's `lat`/`lon` and `color` – bind it to a VIS
  map widget for a quick visual of who is en route, independent of the
  WAIP-Web map itself.
- **Bridge into other ioBroker automations.** Because every field is a
  plain ioBroker state, it composes with anything else already running
  in the instance – forward `einsatz.*` into a smart-home scene engine,
  a Grafana/InfluxDB history for response-time analysis, or a
  Node-RED-style flow via the ioBroker MQTT adapter, without writing a
  single line against the WAIP-Web API.

## Features

- Connects to the `/waip` namespace via `socket.io-client`, registers via
  `emit('WAIP', monitorId)` once (relies on `REGISTRATION_TIMEOUT_MS`
  as a fallback rather than repeated emits, since a redundant emit only
  makes the server reply again without improving delivery reliability)
- Manual reconnect handling (the library's own auto-reconnect is
  disabled) with a configurable delay
- Registration timeout with an audit log (`debug.monitorAudit`)
- Geodata normalization (wgs84 fields, `position`, or GeoJSON `geometry`
  → centroid)
- History of the last 10 completed incidents (`einsatz.json.history10`)
- Separate handlers for alarm (`io.new_waip`), feedback (`io.new_rmld`),
  routes (`io.routes`), TTS (`io.playtts`) and standby (`io.standby`)
- Automatic session-cookie management (see below), so alarm delivery
  keeps working indefinitely without an open browser session
- Server-restart detection via `io.version`, with automatic session
  refresh + reconnect
- Incident, feedback, route and alerted-resource data available as
  separate, flat JSON arrays under `einsatz.json.*` – no nesting, so VIS
  table widgets can bind to them directly
- Aggregated feedback counters per role/capability, mirroring the live
  badges on the web UI
- Clean state on every restart: all states are actively reset to their
  empty value (`false`/`0`/`null`/`[]`) on adapter start, except
  `einsatz.json.history10` and `debug.monitorAudit` (both kept across
  restarts). Note that if the adapter restarts while an incident is
  actively running, its live fields (`einsatz.*`) are cleared too and
  only repopulate once the server sends the next event for that
  incident.
- Stale-data protection: when a new incident starts before the previous
  one's routes/feedback events for the *new* incident have arrived,
  `einsatz.json.routen`/`.rueckmeldungen` and the feedback counters are
  cleared immediately rather than waiting for those events. And if
  `io.standby` is ever missed for an incident (e.g. due to a disconnect
  at the wrong moment), a watchdog automatically finalizes the incident
  once its `ablaufzeit` has passed by more than a grace period
  (60 seconds), instead of leaving stale "active" data indefinitely.
- Only ever shows the single most recently active incident; multiple
  concurrently active incidents can currently only be viewed via the
  WAIP-Web instance's own dashboard

### Why a session cookie is needed

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

## Configuration

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

## States (under `waip-web.0.*`)

Feedback and routes are 1:n lists per incident. They are stored as
**flat** JSON arrays under `einsatz.json.*` (no nested objects/arrays
inside a row) so they can be bound directly to VIS table widgets –
complemented by quick-to-bind counters so bindings and triggers don't
need JSON parsing at all.

### info

| State | Type | Description |
| --- | --- | --- |
| `connection` | boolean | Standard ioBroker indicator: connection to the WAIP server active |

### status

| State | Type | Description |
| --- | --- | --- |
| `connected` | boolean | Socket.IO connection technically established |
| `registeredMonitor` | string | Monitor ID last registered with the server |
| `registeredMonitorName` | string | Display name of that monitor, without the ID (e.g. "Leitstelle: Lausitz"); resolved once at startup from the same `/waip/` overview page as the admin dropdown, `null` if it couldn't be resolved |
| `registrationAccepted` | boolean | `true` once the first event was received, `false` right after connecting or once the registration timeout elapses |
| `registrationPending` | boolean | `true` right after connecting while a response from the server is still awaited, `false` once accepted or timed out |

### einsatz

Flat fields of the currently running incident. Cleared (`null`/`0`) on
`io.standby`, matching the official frontend – `alarmAktiv` is therefore
a reliable switch for whether these fields currently hold real live data.
The most recently finished incident remains available via
`einsatz.json.history10`:

> **Note:** The adapter always reflects only the single most recently
> active incident (`einsatz.*` / `einsatz.json.current`) – matching the
> official WAIP-Web frontend's alarm monitor. WAIP-Web can, in principle,
> have several incidents active at the same time (e.g. two alerts coming
> in close together). These states are **not an array of concurrently
> running incidents** – they get overwritten by each new `io.new_waip`
> event, so a second incident running in parallel is currently not
> visible through this adapter. A complete overview of all currently
> active incidents is, for now, only available via the connected
> WAIP-Web instance's own dashboard.

> **Note:** WAIP-Web's server only fills `einsatznummer`, `objekt`/
> `objektteil`, `besonderheiten`, `strasse`/`hausnummer`,
> `einsatzdetails` and the permission flag for **logged-in** clients
> (`db_user_check_permission_for_waip()` in the server's own
> `server/waip.js`) - since this adapter connects without a login by
> design (see [About this adapter](#about-this-adapter)), the server
> always sends these blank/`false`. They are therefore not exposed as
> states at all rather than permanently carrying dead values.

| State | Type | Description |
| --- | --- | --- |
| `alarmAktiv` | boolean | `true` since the last `io.new_waip`, `false` since the last `io.standby` |
| `restzeit` | number (s) | Remaining seconds until `ablaufzeit`, updated every second |
| `id` | number | Internal incident ID |
| `uuid` | string | Unique incident UUID (also used to associate feedback) |
| `einsatzart` | string | e.g. "Brandeinsatz" (fire), "Hilfeleistungseinsatz" (technical assistance), "Rettungseinsatz" (rescue/EMS), "Krankentransport" (patient transport) |
| `stichwort` | string | Alarm keyword |
| `ort` | string | Location/town |
| `ortsteil` | string | District (if different from `ort`) |
| `zeitstempel` | string (date) | Alarm time |
| `ablaufzeit` | string (date) | End of the standby display duration, basis for `restzeit` |
| `sondersignal` | number | `1` = special signal (lights & siren), otherwise none |
| `latitude` / `longitude` | number | Incident location (normalized from wgs84 fields or GeoJSON centroid) |
| `routenGesamt` | number | Number of routes in the current incident |
| `rueckmeldungGesamt` | number | Total feedback count for the current incident |
| `rueckmeldungAnzahl.ek` | number | Feedback count as team member ("Einsatzkraft") |
| `rueckmeldungAnzahl.gf` | number | Feedback count as crew leader ("Gruppenführer") |
| `rueckmeldungAnzahl.zf` | number | Feedback count as division chief ("Zugführer") |
| `rueckmeldungAnzahl.vf` | number | Feedback count as group commander ("Verbandsführer") |
| `rueckmeldungAnzahl.agt` | number | Feedback count with breathing-apparatus qualification ("Atemschutzgeräteträger") |
| `rueckmeldungAnzahl.fzf` | number | Feedback count as vehicle commander ("Fahrzeugführer") |
| `rueckmeldungAnzahl.ma` | number | Feedback count as driver/operator ("Maschinist") |
| `rueckmeldungAnzahl.med` | number | Feedback count with a medical qualification |

### einsatz.json

Flat JSON objects/arrays, one level deep at most, meant to be bound
directly to VIS table widgets (nested structures like a plain
`{routen, rueckmeldungen, ...}` object generally aren't rendered by
those widgets). `routen`/`rueckmeldungen`/`emAlarmiert`/`emWeitere` only
ever hold the *current* incident's data – they are cleared (`[]`) on
`io.standby` and are **not** part of the history. As with `einsatz.*`
above, `current` only ever holds the single most recently active
incident – see the note in the [`einsatz`](#einsatz) section.

| State | Type | Description |
| --- | --- | --- |
| `current` | string (JSON array) | Current incident's flat data: the same 11 fields as the individual `einsatz.*` states above (`id` … `zeitstempel`, plus `lat`/`lon`), plus `registeredMonitor`/`registeredMonitorName` (the monitor the adapter was registered to at the time), bundled as one object inside a single-element array (`[]` if no incident is active) – the array wrapper is needed because most table widgets require an array at the root, not a bare object |
| `history10` | string (JSON array) | Last 10 completed incidents, same shape as `current`, one array entry per incident, written on `io.standby` |
| `routen` | string (JSON array) | Routes of the current incident; each entry has `nr_wache`, `name_wache`, `color`, `lat`, `lon` (`position` resolved to flat `lat`/`lon`) |
| `rueckmeldungen` | string (JSON array) | Feedback entries of the current incident, as received from the server |
| `emAlarmiert` | string (JSON array) | Alerted resources of the current incident; each entry has `name`, `zeit`, `wache`, `zeit_alarmierung_iso`, `zeit_ausgerueckt_iso` |
| `emWeitere` | string (JSON array) | Additional resources of the current incident, same shape as `emAlarmiert` |

### einsatz.tts

Voice announcement (`io.playtts`) for the currently running incident –
lives under `einsatz` rather than its own top-level channel since it has
no meaning without an incident. No history: a TTS announcement only
matters in the moment, so only the most recent one is kept.

| State | Type | Description |
| --- | --- | --- |
| `last` | string (URL) | Full absolute URL of the most recent voice announcement's mp3 file. The server sends only a bare (often relative) path meant to be used as `audio.src` in a browser that shares its origin; the adapter resolves that against the configured WAIP server URL so the link also works outside the WAIP-Web page (e.g. in a VIS audio widget) |
| `lastTimestamp` | string (date) | Time of the last announcement |

### debug

| State | Type | Description |
| --- | --- | --- |
| `lastEvent` | string (JSON array) | Last received socket event (name + timestamp), for connection diagnostics; single-element array (`[]` if none yet), for VIS table-widget compatibility |
| `normalizedPosition` | string (JSON array) | Result of the geodata normalization for the last `io.new_waip` event, as a flat single-element `[{lat, lon}]` array (both `null` if no valid position could be derived; `[]` if no event yet), for VIS table-widget compatibility |
| `rawPayloadShort` | string | Preview (500 characters) of the raw, unnormalized `io.new_waip` payload |
| `ignoredCount` | number | Count of discarded events (payload explicitly named a different monitor ID) |
| `monitorAudit` | string (JSON array) | Chronological log of connect/registration/reconnect events (200 entries) |
| `sessionExpires` | string (date) | Expiry time of the session cookie as of the last renewal |
| `lastError` | string | Last error message reported by the server (`io.error`); plain text, not JSON, as the server sends this as a bare string |
| `serverVersion` | string | Last reported server instance ID (`io.version`); a change suggests a server restart |

## Logging

All log text is in English. Repeatable failure conditions (session-cookie
renewal, WAIP registration, the Socket.IO connection, a wrong-monitor
event flood) are logged once at `warn` on first occurrence, then at
`debug` while they persist, and once at `info` on recovery – matching the
[official ioBroker logging guideline](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/adapterdev.md#logging).

See **[LOGGING.md](LOGGING.md)** for the full reference of every log
message the adapter can produce, grouped by level, with its cause and an
example.

## Changelog

### 0.7.19 (2026-08-22)

- Fixed a bug where incoming feedback (`io.new_rmld`) was silently
  dropped as "wrong monitor" whenever the responding station's number
  (`wache_nr`) differed from the registered monitor ID:
  `payloadMonitorMatch()` incorrectly treated `wache_nr`/`wache_id`/
  `wacheId` as monitor-identifying fields, but confirmed against the
  WAIP-Web server source, `wache_nr` on a feedback event is the station
  number of the crew that submitted it, unrelated to the monitor/
  dispatch-center ID. Removed these three from the match candidates -
  alarms and routes were never affected (they don't carry these
  fields).

### 0.7.18 (2026-08-22)

- Fixed `debug.lastEvent`/`debug.normalizedPosition` to hold a
  single-element JSON array instead of a bare object (matching
  `einsatz.json.current`), for direct VIS table-widget compatibility,
  and to correctly initialize to `[]` instead of `null` on a fresh
  install/restart.
- Removed `einsatz.einsatznummer`/`.objekt`/`.objektteil`/
  `.besonderheiten`/`.strasse`/`.hausnummer`/`.einsatzdetails`/
  `.permissions` (and the corresponding fields in
  `einsatz.json.current`/`.history10`): confirmed via the WAIP-Web
  server source (`server/waip.js`,
  `db_user_check_permission_for_waip()`) that these fields are only
  ever populated for logged-in clients - since this adapter connects
  anonymously by design, they were always empty/`false`. Removed
  instead of permanently carrying dead states - see the note in the
  [`einsatz`](#einsatz) section.

### 0.7.17 (2026-08-22)

- Fixed `cleanupObsoleteObjects()` incorrectly deleting and recreating
  the `einsatz.json` channel on every restart (it wasn't checking
  `obj.type`, so the current channel object was mistaken for a leftover
  state from before the 0.7.15 migration).
- Fixed a spurious `status.registrationPending` "no existing object"
  warning that could occur if the adapter was stopped before object
  initialization had finished.
- Reduced WAIP registration from three emits to a single emit - Socket.IO
  already delivers reliably once connected, and the existing registration
  timeout remains as the safety net for the rare case it doesn't confirm.
- `permissions` inside `einsatz.json.current`/`.history10` is now always
  stringified consistently with the standalone `einsatz.permissions`
  state, and `einsatz.json.current` is wrapped in a single-element array
  (VIS table widgets require an array at the root, not a bare object).
- Fixed `einsatz.json.history10`/`debug.monitorAudit` staying `null`
  instead of `[]` on a fresh install (they're excluded from the
  per-restart reset to preserve history, which previously also meant
  they were never initialized at all on first install).
- Added `registeredMonitor`/`registeredMonitorName` fields to
  `einsatz.json.current`/`.history10`.
- Reworked logging: translated all remaining German log text to
  English; implemented the official first-occurrence-`warn`/
  repeat-`debug`/recovery-`info` pattern for recurring failures (session
  cookie, registration, connection); capped noisy Socket.IO ping/pong
  debug logging; a sustained flood of wrong-monitor events now escalates
  to `warn` instead of staying at `info` indefinitely. See
  [LOGGING.md](LOGGING.md) for the full reference.
- Documentation: added a table of contents, a practical-use-cases
  section, a known-limitation note (only the single most recently active
  incident is shown - see [`einsatz`](#einsatz)), and enforced the
  changelog's own 5-entry limit.

### 0.7.16 (2026-08-22)

- Fixed two stale-data gaps around incident transitions:
  - When a new incident starts before its own routes/feedback events
    arrive, `einsatz.json.routen`/`.rueckmeldungen` and the feedback
    counters are now cleared immediately instead of waiting for those
    events.
  - Added a watchdog that automatically finalizes an incident
    (archives it, clears live fields) if its `ablaufzeit` is exceeded
    by more than 60s without a matching `io.standby` ever arriving -
    previously a missed `io.standby` (e.g. due to a disconnect at the
    wrong moment) could leave stale "active" data indefinitely.

### 0.7.15 (2026-08-22)

- Restructured `einsatz.json` into a channel with flat,
  table-widget-friendly sub-states (`current`/`history10`/`routen`/
  `rueckmeldungen`/`emAlarmiert`/`emWeitere`) - nested JSON wasn't
  rendering in VIS table widgets.
- Moved `tts.*` under `einsatz.tts.*` (removed the meaningless
  `tts.history10`); `tts.last` now resolves to a full absolute mp3 URL
  instead of the server's often-relative path.
- Moved `status.alarmAktiv`/`status.restzeit` to
  `einsatz.alarmAktiv`/`einsatz.restzeit`.
- Flattened `debug.normalizedPosition` and corrected
  `debug.lastError`'s role from `json` to `text`.
- All states are now actively reset to their empty value on every
  adapter start, except `einsatz.json.history10` and
  `debug.monitorAudit`, which persist across restarts.

Older entries have moved to [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

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
