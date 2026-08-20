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
- History der letzten 10 Einsätze (`history.last10`)
- Getrennte Handler für Alarm (`io.new_waip`), Rückmeldung (`io.new_rmld`),
  Routen (`io.routes`) und TTS (`io.playtts`)

## Konfiguration

In der Admin-Oberfläche der Adapterinstanz:

| Feld | Beschreibung | Default |
| --- | --- | --- |
| WAIP-Server-URL | Basis-URL des WAIP-Servers | `https://wachalarm.leitstelle-lausitz.de` |
| Monitor-ID | Monitor-Kennung; leer/`0` = globaler Monitor | *(leer)* |
| Registrierungs-Timeout (ms) | Zeit bis eine ausbleibende Registrierungsbestätigung geloggt wird | `10000` |
| Wiederverbindungs-Verzögerung (ms) | Wartezeit vor manuellem Reconnect nach Disconnect/Fehler | `5000` |

## States (Auszug, unter `waip-web.0.*`)

- `info.connection`, `status.connected`, `status.alarmAktiv`, `status.restzeit`
- `status.registeredMonitor`, `status.registrationAccepted`
- `json.raw`, `json.einsatz`
- `geo.latitude`, `geo.longitude`, `geo.position`
- `einsatz.id` / `uuid` / `einsatzart` / `stichwort` / `ort` / `ortsteil` / `ablaufzeit` / `sondersignal`
- `rueckmeldung.last.json`, `routen.json`, `routen.count`, `tts.last`, `tts.lastTimestamp`
- `history.last10`
- `debug.lastEvent`, `debug.normalizedPosition`, `debug.rawPayloadShort`, `debug.ignoredCount`, `debug.monitorAudit`

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
