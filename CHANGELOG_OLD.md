# Older changes

### 0.7.4 (2026-08-21)

- Bumped the `ioBroker/testing-action-check` GitHub Action used by the
  `check-and-lint` CI job from `@v1` to `@v2` (via a
  [Dependabot](https://github.com/rnc11/ioBroker.waip-web/pull/10) PR -
  the first one filed by the `.github/dependabot.yml` added in 0.7.3).
  Purely additive on the action's side (adds an optional `test-command:
  'false'` flag), no behavior change for us.

### 0.7.3 (2026-08-21)

*(Never tagged/published to npm - superseded directly by 0.7.4; kept
here for a complete history of what was worked on.)*

- Addressed further findings from the official ioBroker Check and
  Service Bot (which re-scans the repository after every push):
  - Removed the deprecated `common.materialize` field from
    `io-package.json` (superseded by `common.adminUI.config`)
  - Raised `engines.node` to `>=22` and dropped Node.js 20 (reached
    End of Life on 2026-04-30) from the CI test matrix
  - Raised the `admin` dependency to `>=7.8.23`
  - Moved the `check-and-lint` CI job to Node 24.x
  - Added `.github/dependabot.yml` for automated dependency updates
    (weekly `npm`/`github-actions` checks)

### 0.7.2 (2026-08-21)

- README is now English-only (per the official ioBroker adapter checker,
  which flags mixed-language READMEs); the German version moved to a
  separate [README.de.md](README.de.md), linked near the top.
- Moved the License section to the very end of the file (was before the
  Changelog) - the checker requires License to be the last section.
- `package.json`: raised `engines.node` to `>=20` and `@iobroker/adapter-core`
  to `^3.4.1`.
- `io-package.json`: raised the `js-controller` dependency to `>=6.0.11`
  and the `admin` dependency to `>=7.6.17`; removed the `0.7.0` news
  entry (never published to npm, only `0.7.1` and later actually are).
- `admin/jsonConfig.json`: added the root `"i18n": true` attribute (now
  required since the fields resolve translations from `admin/i18n/*.json`)
  and explicit `xs`/`xl` grid sizes on all fields.
- `main.js`: `require('http')`/`require('https')`/`require('url')` now
  use the `node:` prefix for Node's built-in modules.
- `.gitignore`: added `.commitinfo`.
- Removed `.npmignore` - redundant with the `files` allowlist already
  used in `package.json`.
- CI: `adapter-tests` now explicitly declares `needs: check-and-lint`;
  raised the Node.js version used by the `check-and-lint` and `deploy`
  jobs.

### 0.7.1 (2026-08-21)

- Added a License badge to the README.

### 0.7.0 (2026-08-21)

- Prepared the admin UI for community translation via
  [ioBroker's Weblate](https://weblate.iobroker.net/engage/adapters/):
  added `@iobroker/adapter-dev` as a dev dependency (`npm run
  translate`), converted `admin/jsonConfig.json`'s `label`/`help` fields
  from inline `en`/`de` objects to plain English keys, and added
  `admin/i18n/{en,de,ru,pt,nl,fr,it,es,pl,uk,zh-cn}.json` (German
  curated manually, the rest auto-translated via the official
  `translate-adapter` tool — the same tool that already maintains the
  `io-package.json` translations). Added a "Translation status" badge to
  the README; like the "installed"/"stable" badges, it only shows real
  data once the adapter is actually registered as a component on
  weblate.iobroker.net (not done yet).

### 0.6.11 (2026-08-21)

- README: logo now shown enlarged (115×115) via a new
  `admin/waip-web-logo.png`, nearest-neighbor-scaled from the 32×32
  source icon for a crisp (if visibly pixelated) result instead of a
  blurry interpolated one — no higher-resolution source exists anywhere
  in the WAIP-Web ecosystem (checked the Lausitz instance and the
  upstream project, both use the same 32×32 favicon). The actual
  ioBroker adapter icon (`admin/waip-web.png`, referenced from
  `io-package.json`) is unchanged.
- Simplified the README title back to "ioBroker.waip-web".

### 0.6.10 (2026-08-21)

- Added the adapter logo and npm/installation badges (NPM version,
  downloads, installed, stable) to the README, matching standard
  ioBroker adapter conventions. The "installed"/"stable" badges won't
  show meaningful data until the adapter is listed in the official
  [ioBroker.repositories](https://github.com/ioBroker/ioBroker.repositories)
  ("latest" repository PR pending), but will populate automatically once
  it is.

### 0.6.9 (2026-08-21)

- Fixed adapter-checker finding **[E254]**: removed `common.news` entries
  for versions that were never actually published to npm (`0.6.1`–`0.6.5`,
  `0.6.7` were only version bumps in git/GitHub, without a matching
  tagged npm release). `common.news` now only lists versions that really
  exist on the npm registry (`0.6.6`, `0.6.8`); the full history remains
  in this changelog regardless of what was actually published.

### 0.6.8 (2026-08-21)

- Renamed the README title to "ioBroker-Adapter (ioBroker.waip-web)".
- This release doubles as the first end-to-end test of the automatic
  npm publish via Trusted Publishing introduced in 0.6.7.

### 0.6.7 (2026-08-21)

- Enabled automatic npm publishing: the `deploy` job in
  `.github/workflows/test-and-release.yml` is no longer commented out
  and now runs on every version tag (`vX.Y.Z`), publishing to npm via
  [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC,
  no `NPM_TOKEN` secret needed).

### 0.6.6 (2026-08-21)

- Added `.gitattributes` `eol=lf` so all contributors get consistent LF
  line endings regardless of their local git `autocrlf` setting
  (previously caused hundreds of spurious local lint errors on Windows
  without affecting CI, since CI checkouts weren't affected).
- Added `package-lock.json` and switched CI to the default `npm ci` with
  caching instead of `npm install` without caching, now that a lockfile
  exists.

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
  admin UI (the behavior itself is unchanged).
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
