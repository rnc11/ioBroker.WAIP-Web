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

## Features

- Connects to the `/waip` namespace via `socket.io-client`, registers via
  `emit('WAIP', monitorId)` (emitted 3× for robustness)
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
| `strasse` / `hausnummer` | string | Address |
| `objekt` / `objektteil` | string | Building name and part |
| `einsatzdetails` | string | Extra details (only populated for fire/technical-assistance incidents) |
| `besonderheiten` | string | Free-text remarks from the dispatch center |
| `zeitstempel` | string (date) | Alarm time |
| `ablaufzeit` | string (date) | End of the standby display duration, basis for `restzeit` |
| `einsatznummer` | string | Incident number (if assigned by the server) |
| `sondersignal` | number | `1` = special signal (lights & siren), otherwise none |
| `permissions` | string | The registration's permission flag (full access to the detail map yes/no); always stringified (e.g. `"true"`), since the server sends it as a raw boolean |
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
`io.standby` and are **not** part of the history.

| State | Type | Description |
| --- | --- | --- |
| `current` | string (JSON) | Current incident's flat data: the same 19 fields as the individual `einsatz.*` states above (`id` … `permissions`, plus `lat`/`lon`), bundled as one object |
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
| `lastEvent` | string (JSON) | Last received socket event (name + timestamp), for connection diagnostics |
| `normalizedPosition` | string (JSON) | Result of the geodata normalization for the last `io.new_waip` event, as a flat `{lat, lon}` object (both `null` if no valid position could be derived) |
| `rawPayloadShort` | string | Preview (500 characters) of the raw, unnormalized `io.new_waip` payload |
| `ignoredCount` | number | Count of discarded events (payload explicitly named a different monitor ID) |
| `monitorAudit` | string (JSON array) | Chronological log of connect/registration/reconnect events (200 entries) |
| `sessionExpires` | string (date) | Expiry time of the session cookie as of the last renewal |
| `lastError` | string | Last error message reported by the server (`io.error`); plain text, not JSON, as the server sends this as a bare string |
| `serverVersion` | string | Last reported server instance ID (`io.version`); a change suggests a server restart |

## Changelog

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

### 0.7.14 (2026-08-22)

- Fixed **[E1032]**/**[E2004]**: trimmed `common.news` to the 7
  entries allowed by the repository builder and removed the orphaned
  `0.7.10` entry (never published to npm).
- Fixed **[W0066]**: pinned `@types/node` to `^22.0.0` (was `>=22`,
  resolving to a mismatched `26.x`).
- Fixed **[W4040]**/**[W4042]**: corrected the `.vscode/settings.json`
  JSON schema URLs for `io-package.json`/`jsonConfig` to the ones
  ioBroker actually expects.
- Fixed **[S8914]**: replaced the custom Dependabot auto-merge
  workflow with the canonical
  `iobroker-bot-orga/action-automerge-dependabot@v1` action and added
  the matching `.github/auto-merge.yml` (production: patch always,
  minor only for security fixes; development: minor allowed too).
- No runtime changes.

### 0.7.13 (2026-08-22)

- Addressed all remaining `ioBroker.repositories` checker suggestions:
  - **[S0065]**/**[S0085]**/**[S0087]**: added devDependencies
    `@types/node` and `@tsconfig/node22`, plus a `tsconfig.json` for
    editor tooling (no `checkJs`, so this doesn't introduce any new
    type-check warnings).
  - **[S4036]**: added `.vscode/settings.json` with JSON schemas for
    `io-package.json`/`admin/jsonConfig.json`.
  - **[S5026]**: added the `release-script-plugin-manual-review`
    plugin (adds a confirm-before-commit step to interactive
    `npm run release` runs only).
  - **[S8913]**: added a Dependabot auto-merge workflow for
    patch/minor updates; major version bumps still require manual
    review.
  - No runtime changes.

### 0.7.12 (2026-08-21)

- Fixed **[E3005]**: `einsatz.permissions` is declared as
  `common.type: "string"`, but `setField()` passed raw
  booleans/numbers through unchanged (the WAIP server sends this
  field as a raw boolean flag), so the stored `val` didn't match the
  declared type. `setField()` now looks up the declared type and
  always stringifies values for string-typed states, regardless of
  the incoming JS type - found by the `ioBroker.repositories` object
  structure check.

### 0.7.11 (2026-08-21)

- Fixed **[E3009]** (57 findings): added the missing channel/folder
  objects (`status`, `einsatz`, `einsatz.rueckmeldungAnzahl`, `debug`,
  `tts`) that ioBroker requires for every state path segment - found
  by the `ioBroker.repositories` object structure check.
- Fixed **[E3005]**/**[E1009]**: replaced the unsupported
  `common.type: "mixed"` on `einsatz.permissions` (now `string`) and
  `status.registrationAccepted` (now split into two booleans:
  `registrationAccepted` and the new `registrationPending`).

### 0.7.10 (2026-08-21)

- Fixed **[S9508]**: excluded `CHANGELOG_OLD.md` from the npm package
  (removed from `package.json`'s `files` allowlist) - ioBroker shows
  the README via a GitHub link, not from the installed npm package, so
  the file remains fully readable on GitHub without needing to ship
  inside the tarball.

### 0.7.9 (2026-08-21)

- Fixed **[E5025]**/**[E5036]**: installed the missing
  `@alcalzone/release-script-plugin-license` dev dependency required
  for the `"license"` plugin referenced in `.releaseconfig.json`.

### 0.7.8 (2026-08-21)

- Fixed **[E5018]**: added the missing `.releaseconfig.json` (`plugins:
  iobroker, license`) required now that `@alcalzone/release-script` is
  a dev dependency - caught by the `ioBroker.repositories` "ADD TO
  LATEST" submission check.

### 0.7.7 (2026-08-21)

- Fixed **[E254]**: removed the orphaned `0.7.5` entry from
  `common.news` - like `0.7.0` and `0.7.3` before it, that version was
  never actually tagged/published to npm (`0.7.4` was followed directly
  by `0.7.6`, which is now confirmed live under `latest`).

### 0.7.6 (2026-08-21)

- Fixed **[W6019]** and **[W0062]**: added `@alcalzone/release-script`
  and `@alcalzone/release-script-plugin-iobroker` as dev dependencies
  (with an `npm run release` script), and split this changelog - the 5
  most recent entries stay here, everything older moved to
  [CHANGELOG_OLD.md](CHANGELOG_OLD.md). Our existing manual
  version-bump/tag workflow (see below) is unchanged; the tool is
  available but not actively used for releasing yet.

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
