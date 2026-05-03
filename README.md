# PiBoatServer

PiBoatServer is the central Node.js receiver for PiBoatCore boat telemetry. It
accepts heartbeats from one or more Raspberry Pis, stores raw heartbeat history
as JSONL, and keeps a latest-per-boat/device index for dashboards or alerts.

It currently uses only Node.js built-ins so it can run anywhere Node 20+ is
available. A database can be added later without changing the Pi heartbeat
contract.

## Run

```bash
cd PiBoatServer
npm start
```

The server listens on `http://0.0.0.0:3000` by default.

Visit `/` to view the basic boat dashboard.

## Environment

See `.env.example`.

- `PORT`: HTTP port
- `HOST`: bind address
- `DATA_DIR`: directory for JSONL history and latest index
- `MAX_BODY_BYTES`: maximum request body size
- `MAX_SNAPSHOT_BYTES`: maximum camera snapshot size
- `API_TOKEN`: optional bearer token required for `POST /api/heartbeat`

## API

### `GET /health`

Returns server health.

### `POST /api/heartbeat`

Accepts a heartbeat from PiBoatCore.

If `API_TOKEN` is set, send:

```text
Authorization: Bearer your-token
```

### `GET /api/boats`

Lists known boats and device ids.

### `GET /api/boats/:boatId/latest`

Returns latest heartbeat records for a boat, keyed by device id.

### `GET /api/boats/:boatId/history?limit=100`

Returns recent heartbeat history for a boat.

### `POST /api/snapshot`

Accepts a JPEG snapshot from PiBoatCore. Requires the same bearer token as
heartbeat ingestion when `API_TOKEN` is set.

Required headers:

```text
Content-Type: image/jpeg
X-Boat-Id: my-boat
X-Device-Id: raspberry-pi-bridge
X-Sent-At: 2026-05-03T12:00:00Z
```

## Data Files

- `data/heartbeats.jsonl`: append-only heartbeat history
- `data/latest.json`: latest heartbeat per boat and device

This is intentionally simple for the first deployment. For production history,
the next natural step is PostgreSQL or SQLite with retention policies.
