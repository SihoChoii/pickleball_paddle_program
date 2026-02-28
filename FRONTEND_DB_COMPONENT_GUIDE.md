# Frontend Components: Database Contract Guide

This project does **not** use a relational schema. It uses **InfluxDB 3** time-series data.

Use this file as the source of truth when asking an LLM to generate frontend components.

## 1. Actual Database Structure (Current Project)

- DB engine: `InfluxDB 3` (SQL query language via `InfluxDBClient3`)
- Database name: env `INFLUX_DATABASE` (current default: `imu_data`)
- Measurement/table name: env `INFLUX_MEASUREMENT` (current default: `imu_data`)
- Write source: `Arduino Code/imu/python/main.py`
- Read/API source: `backend/app/main.py`

### 1.1 Line Protocol Being Written

Data is written in this shape:

```text
imu_data,device=arduino_uno_q x=<float>,y=<float>,z=<float>,roll=<float>,pitch=<float>,yaw=<float> <timestamp_ns>
```

### 1.2 Columns You Can Depend On

- `time` (timestamp; written as nanosecond epoch, returned by API as ISO UTC string)
- `x` (float, acceleration in `g`)
- `y` (float, acceleration in `g`)
- `z` (float, acceleration in `g`)
- `roll` (float, gyroscope in `deg/s`)
- `pitch` (float, gyroscope in `deg/s`)
- `yaw` (float, gyroscope in `deg/s`)
- tag `device` (string; currently always `arduino_uno_q`)

## 2. Backend API Contracts (Use These for Frontend Components)

Base URL is the same host as frontend (FastAPI serves both).

## 2.1 `GET /api/health`

```json
{ "status": "ok" }
```

## 2.2 `GET /api/imu/latest`

- Query used: `SELECT time, x, y, z, roll, pitch, yaw FROM "<measurement>" ORDER BY time DESC LIMIT 1`
- Returns latest row only.
- Returns `404` if no data.

Response shape:

```json
{
  "timestamp": "2026-02-28T15:12:01.123456+00:00",
  "acceleration": { "x": 0.0123, "y": -0.0012, "z": 1.0034 },
  "gyroscope": { "roll": 0.4, "pitch": -0.2, "yaw": 1.1 }
}
```

## 2.3 `GET /api/imu/all`

- Query used: `SELECT time, x, y, z, roll, pitch, yaw FROM "<measurement>" ORDER BY time DESC`
- Returns newest-first history.
- If empty, returns `{ "count": 0, "entries": [] }` (not an error).

Response shape:

```json
{
  "count": 2,
  "entries": [
    {
      "timestamp": "2026-02-28T15:12:01.123456+00:00",
      "x": 0.0123,
      "y": -0.0012,
      "z": 1.0034,
      "roll": 0.4,
      "pitch": -0.2,
      "yaw": 1.1
    }
  ]
}
```

## 2.4 `GET /api/imu/throughput?window_seconds=60`

- `window_seconds` is clamped to `10..600`.
- Returns per-second counts for the full window (including zero-count seconds).
- `latest_complete_dps` is count for `now - 1 second`.

Response shape:

```json
{
  "window_seconds": 60,
  "latest_complete_dps": 59,
  "average_dps": 58.42,
  "points": [
    { "timestamp": "2026-02-28T15:11:02+00:00", "count": 57 },
    { "timestamp": "2026-02-28T15:11:03+00:00", "count": 60 }
  ]
}
```

## 3. TypeScript Interfaces (Recommended for New Frontend)

```ts
export interface HealthResponse {
  status: "ok";
}

export interface ImuLatestResponse {
  timestamp: string | null; // ISO-8601 UTC
  acceleration: {
    x: number;
    y: number;
    z: number;
  };
  gyroscope: {
    roll: number;
    pitch: number;
    yaw: number;
  };
}

export interface ImuHistoryEntry {
  timestamp: string | null; // ISO-8601 UTC
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export interface ImuAllResponse {
  count: number;
  entries: ImuHistoryEntry[];
}

export interface ThroughputPoint {
  timestamp: string; // ISO-8601 UTC, 1-second buckets
  count: number;
}

export interface ImuThroughputResponse {
  window_seconds: number; // 10..600
  latest_complete_dps: number;
  average_dps: number;
  points: ThroughputPoint[];
}
```

## 4. Component Design Rules for LLM-Generated Frontend

- Treat this as **time-series telemetry**, not relational app data.
- Do not invent IDs, users, or joins. No table relations exist here.
- Render UTC timestamps safely (`null` possible for `timestamp` in `latest` and `all` entries).
- Handle `404` from `/api/imu/latest` as "waiting for sensor data", not as fatal app error.
- `/api/imu/all` can be large; virtualize/paginate in a production UI if needed.
- Keep throughput chart bound to `points[].count` and `points[].timestamp`.

## 5. Data Origin and Units (Important for Labels)

From the writer:

- Raw accelerometer values are divided by `1000.0` before write.
- Raw gyroscope values are divided by `10.0` before write.
- `x/y/z` should be labeled as acceleration (`g`).
- `roll/pitch/yaw` should be labeled as gyroscope (`deg/s`).

## 6. Polling Baseline in Current Mock Frontend

Current mock frontend (`frontend/app.js`) uses:

- latest: every `250ms`
- history: every `3000ms`
- throughput: every `1000ms`

You can keep this behavior or replace with WebSocket/SSE later.

## 7. Ready-to-Paste Prompt Seed for an LLM

Use this when asking another LLM to generate components:

```text
Build frontend components against these exact API contracts only:
- GET /api/imu/latest => ImuLatestResponse
- GET /api/imu/all => ImuAllResponse
- GET /api/imu/throughput?window_seconds=60 => ImuThroughputResponse
- GET /api/health => HealthResponse

Database is InfluxDB time-series (measurement: imu_data), not relational tables.
Fields are x,y,z,roll,pitch,yaw + time; tag device exists but is not currently exposed by backend responses.
Implement loading/empty/error states, and treat /api/imu/latest 404 as “no sensor data yet”.
```
