from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
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

INFLUX_URL = os.getenv("INFLUX_URL")
INFLUX_TOKEN = os.getenv("INFLUX_TOKEN")
INFLUX_DATABASE = os.getenv("INFLUX_DATABASE") or os.getenv("INFLUX_BUCKET")
INFLUX_MEASUREMENT = os.getenv("INFLUX_MEASUREMENT", "imu_data")

EXPECTED_FIELDS = {"x", "y", "z", "roll", "pitch", "yaw"}

app = FastAPI(title="IMU Influx Reader")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        missing = [
            key
            for key, value in {
                "INFLUX_URL": INFLUX_URL,
                "INFLUX_TOKEN": INFLUX_TOKEN,
                "INFLUX_DATABASE": INFLUX_DATABASE,
            }.items()
            if not value
        ]
        if missing:
            raise HTTPException(
                status_code=500,
                detail=f"Missing required environment values: {', '.join(missing)}",
            )
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
    scalar = chunked[row_index]
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
    # pyarrow can expose ns timestamps as integer epoch nanoseconds
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
            raise HTTPException(
                status_code=404,
                detail=(
                    f"No IMU table '{INFLUX_MEASUREMENT}' in database "
                    f"'{INFLUX_DATABASE}'. Write at least one IMU point first."
                ),
            ) from exc
        raise HTTPException(status_code=502, detail=f"Influx query failed: {message}") from exc
    except Exception as exc:  # pragma: no cover - defensive fallback
        raise HTTPException(status_code=500, detail=f"Unexpected backend error: {exc}") from exc


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/imu/latest")
def get_latest_imu() -> dict[str, Any]:
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    query = (
    "SELECT time, x, y, z, roll, pitch, yaw "
    f"FROM {table_name} ORDER BY time DESC LIMIT 2500"
    )   

    arrow_table = _query_imu(query)

    if getattr(arrow_table, "num_rows", 0) == 0:
        raise HTTPException(status_code=404, detail="No IMU data found")

    row = {
        "x": float(_read_arrow_scalar(arrow_table, "x", 0)),
        "y": float(_read_arrow_scalar(arrow_table, "y", 0)),
        "z": float(_read_arrow_scalar(arrow_table, "z", 0)),
        "roll": float(_read_arrow_scalar(arrow_table, "roll", 0)),
        "pitch": float(_read_arrow_scalar(arrow_table, "pitch", 0)),
        "yaw": float(_read_arrow_scalar(arrow_table, "yaw", 0)),
    }
    missing_fields = sorted(list(EXPECTED_FIELDS - set(row.keys())))
    if missing_fields:
        raise HTTPException(
            status_code=404,
            detail=f"IMU data is incomplete. Missing fields: {', '.join(missing_fields)}",
        )

    timestamp = _read_arrow_time_iso(arrow_table, 0)

    return {
        "timestamp": timestamp,
        "acceleration": {
            "x": row["x"],
            "y": row["y"],
            "z": row["z"],
        },
        "gyroscope": {
            "roll": row["roll"],
            "pitch": row["pitch"],
            "yaw": row["yaw"],
        },
    }


@app.get("/api/imu/all")
def get_all_imu() -> dict[str, Any]:
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    query = (
        "SELECT time, x, y, z, roll, pitch, yaw "
        f"FROM {table_name} ORDER BY time DESC"
    )

    arrow_table = _query_imu(query)
    if getattr(arrow_table, "num_rows", 0) == 0:
        return {"count": 0, "entries": []}

    row_count = arrow_table.num_rows
    entries: list[dict[str, Any]] = []

    for i in range(row_count):
        entries.append(
            {
                "timestamp": _read_arrow_time_iso(arrow_table, i),
                "x": float(_read_arrow_scalar(arrow_table, "x", i)),
                "y": float(_read_arrow_scalar(arrow_table, "y", i)),
                "z": float(_read_arrow_scalar(arrow_table, "z", i)),
                "roll": float(_read_arrow_scalar(arrow_table, "roll", i)),
                "pitch": float(_read_arrow_scalar(arrow_table, "pitch", i)),
                "yaw": float(_read_arrow_scalar(arrow_table, "yaw", i)),
            }
        )

    return {"count": len(entries), "entries": entries}


@app.get("/api/imu/throughput")
def get_imu_throughput(window_seconds: int = 60) -> dict[str, Any]:
    window_seconds = max(10, min(window_seconds, 600))
    table_name = _sql_identifier(INFLUX_MEASUREMENT)

    query_window = (
        "SELECT time "
        f"FROM {table_name} "
        f"WHERE time >= now() - INTERVAL '{window_seconds} second' "
        "ORDER BY time ASC"
    )

    # Fallback query for engines that do not support INTERVAL syntax consistently.
    limit = min(window_seconds * 400, 250000)
    query_fallback = (
        "SELECT time "
        f"FROM {table_name} "
        "ORDER BY time DESC "
        f"LIMIT {limit}"
    )

    try:
        arrow_table = _query_imu(query_window)
    except HTTPException:
        arrow_table = _query_imu(query_fallback)
    counts_by_second: dict[int, int] = {}

    row_count = getattr(arrow_table, "num_rows", 0)
    for i in range(row_count):
        raw = _read_arrow_scalar(arrow_table, "time", i)
        dt = _raw_time_to_datetime_utc(raw)
        if dt is None:
            continue
        second_epoch = int(dt.timestamp())
        counts_by_second[second_epoch] = counts_by_second.get(second_epoch, 0) + 1

    now_epoch = int(datetime.now(tz=timezone.utc).timestamp())
    start_epoch = now_epoch - window_seconds + 1

    points: list[dict[str, Any]] = []
    for sec in range(start_epoch, now_epoch + 1):
        points.append(
            {
                "timestamp": datetime.fromtimestamp(sec, tz=timezone.utc).isoformat(),
                "count": counts_by_second.get(sec, 0),
            }
        )

    latest_complete_second = now_epoch - 1
    latest_complete_dps = counts_by_second.get(latest_complete_second, 0)
    average_dps = (
        round(sum(p["count"] for p in points) / len(points), 2) if points else 0.0
    )

    return {
        "window_seconds": window_seconds,
        "latest_complete_dps": latest_complete_dps,
        "average_dps": average_dps,
        "points": points,
    }


@app.on_event("shutdown")
def shutdown() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
