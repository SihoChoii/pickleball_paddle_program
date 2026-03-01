from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from influxdb_client_3 import InfluxDBClient3
from influxdb_client_3.exceptions import InfluxDB3ClientQueryError

ROOT_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = ROOT_DIR / "backend" / ".env"
FRONTEND_DIR = ROOT_DIR / "frontend"

if ENV_PATH.exists():
    load_dotenv(ENV_PATH)
else:
    load_dotenv()

INFLUX_URL         = os.getenv("INFLUX_URL")
INFLUX_TOKEN       = os.getenv("INFLUX_TOKEN")
INFLUX_DATABASE    = os.getenv("INFLUX_DATABASE") or os.getenv("INFLUX_BUCKET")
INFLUX_MEASUREMENT = os.getenv("INFLUX_MEASUREMENT", "imu_data")
EXPECTED_FIELDS    = {"x", "y", "z", "roll", "pitch", "yaw"}

app = FastAPI(title="IMU Influx Reader")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def no_cache_api(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"]        = "no-cache"
        response.headers["Expires"]       = "0"
    return response

_client: InfluxDBClient3 | None = None


def _normalize_url(url: str) -> str:
    value = url.strip().rstrip("/")
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"http://{value}"


def _sql_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def get_client() -> InfluxDBClient3:
    global _client
    if _client is None:
        missing = [k for k, v in {
            "INFLUX_URL": INFLUX_URL,
            "INFLUX_TOKEN": INFLUX_TOKEN,
            "INFLUX_DATABASE": INFLUX_DATABASE,
        }.items() if not v]
        if missing:
            raise HTTPException(status_code=500,
                                detail=f"Missing env values: {', '.join(missing)}")
        _client = InfluxDBClient3(
            host=_normalize_url(INFLUX_URL or ""),
            token=INFLUX_TOKEN,
            database=INFLUX_DATABASE,
        )
    return _client


def _to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _read_arrow_scalar(table, column: str, row_index: int):
    chunked = table.column(column)
    scalar  = chunked[row_index]
    try:
        return scalar.as_py()
    except ValueError:
        if hasattr(scalar, "value"):
            return scalar.value
        raise


def _read_arrow_time_iso(table, row_index: int) -> str | None:
    raw = _read_arrow_scalar(table, "time", row_index)
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return _to_iso(raw)
    if isinstance(raw, int):
        return datetime.fromtimestamp(raw / 1_000_000_000, tz=timezone.utc).isoformat()
    return str(raw)


def _raw_time_to_datetime_utc(raw: Any) -> datetime | None:
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw.astimezone(timezone.utc)
    if isinstance(raw, int):
        return datetime.fromtimestamp(raw / 1_000_000_000, tz=timezone.utc)
    if isinstance(raw, str):
        value = raw.strip()
        # Accept raw nanosecond integer passed as string from frontend
        if value.isdigit() and len(value) > 13:
            return datetime.fromtimestamp(int(value) / 1_000_000_000, tz=timezone.utc)
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            return None
    return None


def _query_imu(query: str):
    try:
        return get_client().query(query=query, language="sql")
    except InfluxDB3ClientQueryError as exc:
        message = str(exc)
        if "table" in message and "not found" in message:
            raise HTTPException(status_code=404, detail=(
                f"No IMU table '{INFLUX_MEASUREMENT}' in '{INFLUX_DATABASE}'. "
                "Write at least one point first."
            )) from exc
        raise HTTPException(status_code=502,
                            detail=f"Influx query failed: {message}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500,
                            detail=f"Unexpected error: {exc}") from exc


def _arrow_to_entries(arrow_table) -> list[dict[str, Any]]:
    entries = []
    for i in range(arrow_table.num_rows):
        entries.append({
            "timestamp": _read_arrow_time_iso(arrow_table, i),
            "x":         float(_read_arrow_scalar(arrow_table, "x", i)),
            "y":         float(_read_arrow_scalar(arrow_table, "y", i)),
            "z":         float(_read_arrow_scalar(arrow_table, "z", i)),
            "roll":      float(_read_arrow_scalar(arrow_table, "roll", i)),
            "pitch":     float(_read_arrow_scalar(arrow_table, "pitch", i)),
            "yaw":       float(_read_arrow_scalar(arrow_table, "yaw", i)),
        })
    return entries


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/imu/latest")
def get_latest_imu() -> dict[str, Any]:
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    query = (
        "SELECT time, x, y, z, roll, pitch, yaw "
        f"FROM {table_name} ORDER BY time DESC LIMIT 1"
    )
    arrow_table = _query_imu(query)
    if getattr(arrow_table, "num_rows", 0) == 0:
        raise HTTPException(status_code=404, detail="No IMU data found")

    row = {f: float(_read_arrow_scalar(arrow_table, f, 0))
           for f in ["x", "y", "z", "roll", "pitch", "yaw"]}
    missing = sorted(EXPECTED_FIELDS - set(row))
    if missing:
        raise HTTPException(status_code=404,
                            detail=f"Missing fields: {', '.join(missing)}")
    return {
        "timestamp":    _read_arrow_time_iso(arrow_table, 0),
        "acceleration": {"x": row["x"], "y": row["y"], "z": row["z"]},
        "gyroscope":    {"roll": row["roll"], "pitch": row["pitch"], "yaw": row["yaw"]},
    }


@app.get("/api/imu/all")
def get_all_imu() -> dict[str, Any]:
    """Returns the most recent 3000 rows, newest-first."""
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    query = (
        "SELECT time, x, y, z, roll, pitch, yaw "
        f"FROM {table_name} ORDER BY time DESC LIMIT 3000"
    )
    arrow_table = _query_imu(query)
    if getattr(arrow_table, "num_rows", 0) == 0:
        return {"count": 0, "entries": []}
    entries = _arrow_to_entries(arrow_table)
    return {"count": len(entries), "entries": entries}



@app.get("/api/imu/session")
def get_session_imu(
    start: str = Query(..., description="ISO-8601 UTC or nanosecond epoch start"),
    end:   str = Query(None, description="ISO-8601 UTC or nanosecond epoch end (omit = now)"),
) -> dict[str, Any]:
    """Returns every data point between start and end, oldest-first, no row cap."""
    table_name = _sql_identifier(INFLUX_MEASUREMENT)

    start_dt = _raw_time_to_datetime_utc(start)
    if start_dt is None:
        raise HTTPException(status_code=400, detail=f"Invalid start: {start!r}")

    if end:
        end_dt = _raw_time_to_datetime_utc(end)
        if end_dt is None:
            raise HTTPException(status_code=400, detail=f"Invalid end: {end!r}")
        where = f"time >= '{start_dt.isoformat()}' AND time <= '{end_dt.isoformat()}'"
    else:
        where = f"time >= '{start_dt.isoformat()}'"

    query = (
        "SELECT time, x, y, z, roll, pitch, yaw "
        f"FROM {table_name} "
        f"WHERE {where} "
        "ORDER BY time ASC"
    )
    arrow_table = _query_imu(query)
    if getattr(arrow_table, "num_rows", 0) == 0:
        return {"count": 0, "entries": [], "start": start, "end": end}
    entries = _arrow_to_entries(arrow_table)
    return {"count": len(entries), "entries": entries, "start": start, "end": end}

@app.get("/api/imu/throughput")
def get_imu_throughput(window_seconds: int = 60) -> dict[str, Any]:
    window_seconds = max(10, min(window_seconds, 600))
    table_name     = _sql_identifier(INFLUX_MEASUREMENT)

    query_window = (
        "SELECT time "
        f"FROM {table_name} "
        f"WHERE time >= now() - INTERVAL '{window_seconds} second' "
        "ORDER BY time ASC"
    )
    limit = min(window_seconds * 400, 250000)
    query_fallback = (
        f"SELECT time FROM {table_name} ORDER BY time DESC LIMIT {limit}"
    )

    try:
        arrow_table = _query_imu(query_window)
    except HTTPException:
        arrow_table = _query_imu(query_fallback)

    counts_by_second: dict[int, int] = {}
    for i in range(getattr(arrow_table, "num_rows", 0)):
        dt = _raw_time_to_datetime_utc(_read_arrow_scalar(arrow_table, "time", i))
        if dt:
            sec = int(dt.timestamp())
            counts_by_second[sec] = counts_by_second.get(sec, 0) + 1

    now_epoch   = int(datetime.now(tz=timezone.utc).timestamp())
    start_epoch = now_epoch - window_seconds + 1
    points = [
        {"timestamp": datetime.fromtimestamp(s, tz=timezone.utc).isoformat(),
         "count":     counts_by_second.get(s, 0)}
        for s in range(start_epoch, now_epoch + 1)
    ]

    avg_dps = round(sum(p["count"] for p in points) / len(points), 2) if points else 0.0
    return {
        "window_seconds":      window_seconds,
        "latest_complete_dps": counts_by_second.get(now_epoch - 1, 0),
        "average_dps":         avg_dps,
        "points":              points,
    }


@app.on_event("shutdown")
def shutdown() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
