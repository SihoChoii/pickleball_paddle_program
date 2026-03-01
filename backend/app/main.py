from __future__ import annotations

import json
import logging
import math
import os
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query
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
INFLUX_DEVICE_TAG = os.getenv("INFLUX_DEVICE_TAG", "arduino_uno_q")

_default_profile_path = Path("backend/data/calibration_profile.json")
CALIBRATION_PROFILE_PATH = Path(os.getenv("CALIBRATION_PROFILE_PATH", str(_default_profile_path)))
if not CALIBRATION_PROFILE_PATH.is_absolute():
    CALIBRATION_PROFILE_PATH = (ROOT_DIR / CALIBRATION_PROFILE_PATH).resolve()

CALIBRATION_WINDOW_SECONDS_DEFAULT = float(os.getenv("CALIBRATION_WINDOW_SECONDS_DEFAULT", "2.5"))
CALIBRATION_WINDOW_SECONDS_MIN = float(os.getenv("CALIBRATION_WINDOW_SECONDS_MIN", "1.0"))
CALIBRATION_WINDOW_SECONDS_MAX = float(os.getenv("CALIBRATION_WINDOW_SECONDS_MAX", "10.0"))
CALIBRATION_MIN_SAMPLES = int(os.getenv("CALIBRATION_MIN_SAMPLES", "90"))
CALIBRATION_MIN_SAMPLE_RATE_HZ = float(os.getenv("CALIBRATION_MIN_SAMPLE_RATE_HZ", "8.0"))
CALIBRATION_MIN_SAMPLES_FLOOR = int(os.getenv("CALIBRATION_MIN_SAMPLES_FLOOR", "40"))

# Backend-side thresholds in database units: accel[g], gyro[deg/s].
CALIBRATION_GYRO_STDDEV_MAX = float(os.getenv("CALIBRATION_GYRO_STDDEV_MAX", "3.0"))
CALIBRATION_GYRO_ANGLE_MEAN_ABS_MIN = float(os.getenv("CALIBRATION_GYRO_ANGLE_MEAN_ABS_MIN", "8.0"))
CALIBRATION_GYRO_DELTA_P95_MAX = float(os.getenv("CALIBRATION_GYRO_DELTA_P95_MAX", "1.2"))
CALIBRATION_ACCEL_MAG_MEAN_MIN = float(os.getenv("CALIBRATION_ACCEL_MAG_MEAN_MIN", "0.85"))
CALIBRATION_ACCEL_MAG_MEAN_MAX = float(os.getenv("CALIBRATION_ACCEL_MAG_MEAN_MAX", "1.15"))
CALIBRATION_ACCEL_MAG_STDDEV_MAX = float(os.getenv("CALIBRATION_ACCEL_MAG_STDDEV_MAX", "0.12"))
CALIBRATION_UPRIGHT_DOMINANT_AXIS_MIN = float(os.getenv("CALIBRATION_UPRIGHT_DOMINANT_AXIS_MIN", "0.55"))

CALIBRATION_REWRITE_BATCH_SIZE = int(os.getenv("CALIBRATION_REWRITE_BATCH_SIZE", "500"))
CALIBRATION_REWRITE_POLL_MS = int(os.getenv("CALIBRATION_REWRITE_POLL_MS", "500"))
CALIBRATION_REWRITE_FAIL_BACKOFF_MS = int(os.getenv("CALIBRATION_REWRITE_FAIL_BACKOFF_MS", "1500"))
CALIBRATION_MAX_FUTURE_SKEW_SECONDS = float(os.getenv("CALIBRATION_MAX_FUTURE_SKEW_SECONDS", "5.0"))
CALIBRATION_CAPTURE_GUARD_SECONDS = float(os.getenv("CALIBRATION_CAPTURE_GUARD_SECONDS", "0.35"))

HTTP_TIMEOUT_S = float(os.getenv("INFLUX_HTTP_TIMEOUT_S", "2.0"))

ACC_SCALE_RAW = 1000.0
GYRO_SCALE_RAW = 10.0

EXPECTED_FIELDS = {"x", "y", "z", "roll", "pitch", "yaw"}
CALIBRATION_PROFILE_SIGNATURE_FIELD = "cal_profile_sig"
CALIBRATION_TRIM_RATIO = float(os.getenv("CALIBRATION_TRIM_RATIO", "0.10"))

app = FastAPI(title="IMU Influx Reader")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("pickleball-backend")

_client: InfluxDBClient3 | None = None

calibration_lock = threading.Lock()
active_calibration_profile: dict[str, Any] | None = None
calibration_effective_from_ns: int | None = None
calibration_last_processed_ns: int | None = None
calibration_last_error: str | None = None
calibration_last_result: dict[str, Any] = {
    "ok": False,
    "message": "No calibration profile active",
    "at_utc": None,
}
calibration_worker_running = False
calibration_rewrite_pause_until_ns = 0

rewrite_worker_stop = threading.Event()
rewrite_worker_thread: threading.Thread | None = None

write_mode_lock = threading.Lock()
write_mode = "v3"


def _normalize_url(url: str) -> str:
    value = url.strip().rstrip("/")
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"http://{value}"


def _sql_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _sql_string_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _profile_signature_from_offsets(offsets: dict[str, int]) -> int:
    payload = ",".join(
        f"{key}:{int(offsets[key])}"
        for key in sorted(offsets.keys())
    ).encode("utf-8")
    # Keep signature deterministic and positive for storage in integer field.
    return max(1, int(zlib.crc32(payload) & 0x7FFFFFFF))


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


def _raw_time_to_epoch_ns(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    dt = _raw_time_to_datetime_utc(raw)
    if dt is None:
        return None
    return int(dt.timestamp() * 1_000_000_000)


def _epoch_ns_to_iso(ns: int) -> str:
    return datetime.fromtimestamp(ns / 1_000_000_000, tz=timezone.utc).isoformat()


def _realtime_upper_ns(now_ns: int | None = None) -> int:
    current_ns = time.time_ns() if now_ns is None else int(now_ns)
    future_skew_ns = int(max(0.0, CALIBRATION_MAX_FUTURE_SKEW_SECONDS) * 1_000_000_000)
    return current_ns + future_skew_ns


def _filter_rows_to_realtime(rows: list[dict[str, Any]], *, now_ns: int | None = None) -> list[dict[str, Any]]:
    upper_ns = _realtime_upper_ns(now_ns)
    return [row for row in rows if row["time_ns"] <= upper_ns]


def _normalize_calibration_profile(raw_profile: Any) -> dict[str, Any] | None:
    if not isinstance(raw_profile, dict):
        return None

    offsets = raw_profile.get("offsets")
    if not isinstance(offsets, dict):
        return None

    required = ("ax", "ay", "az", "gx", "gy", "gz")
    normalized_offsets: dict[str, int] = {}
    try:
        for key in required:
            normalized_offsets[key] = int(round(float(offsets[key])))
    except Exception:
        return None

    profile_signature = _safe_int(
        raw_profile.get("profile_signature"),
        _profile_signature_from_offsets(normalized_offsets),
    )
    if profile_signature <= 0:
        profile_signature = _profile_signature_from_offsets(normalized_offsets)

    sample_count = max(0, _safe_int(raw_profile.get("sample_count", 0), 0))
    window_seconds = _safe_float(raw_profile.get("window_seconds", CALIBRATION_WINDOW_SECONDS_DEFAULT))
    effective_from_ns = _safe_int(raw_profile.get("effective_from_ns", 0), 0)

    metrics = raw_profile.get("metrics") if isinstance(raw_profile.get("metrics"), dict) else {}
    gyro_std = metrics.get("gyro_stddev") if isinstance(metrics.get("gyro_stddev"), dict) else {}
    gyro_delta_abs_p95_raw = (
        metrics.get("gyro_delta_abs_p95")
        if isinstance(metrics.get("gyro_delta_abs_p95"), dict)
        else {}
    )
    accel_target_raw = metrics.get("accel_target") if isinstance(metrics.get("accel_target"), dict) else {}
    accel_target = {
        "x": _safe_float(accel_target_raw.get("x"), 0.0),
        "y": _safe_float(accel_target_raw.get("y"), 0.0),
        "z": _safe_float(accel_target_raw.get("z"), 1.0),
    }

    return {
        "version": int(raw_profile.get("version", 1)),
        "created_at_utc": raw_profile.get("created_at_utc") or _utc_now_iso(),
        "effective_from_ns": max(0, effective_from_ns),
        "source": raw_profile.get("source", "backend_influx_window"),
        "window_seconds": window_seconds,
        "sample_count": sample_count,
        "profile_signature": int(profile_signature),
        "offsets": normalized_offsets,
        "metrics": {
            "accel_magnitude_mean": _safe_float(metrics.get("accel_magnitude_mean"), 0.0),
            "accel_magnitude_stddev": _safe_float(metrics.get("accel_magnitude_stddev"), 0.0),
            "gyro_stddev": {
                "gx": _safe_float(gyro_std.get("gx"), 0.0),
                "gy": _safe_float(gyro_std.get("gy"), 0.0),
                "gz": _safe_float(gyro_std.get("gz"), 0.0),
            },
            "gyro_delta_abs_p95": {
                "gx": _safe_float(gyro_delta_abs_p95_raw.get("gx"), 0.0),
                "gy": _safe_float(gyro_delta_abs_p95_raw.get("gy"), 0.0),
                "gz": _safe_float(gyro_delta_abs_p95_raw.get("gz"), 0.0),
            },
            "gyro_angle_like": bool(metrics.get("gyro_angle_like", False)),
            "accel_target": accel_target,
            "trim_ratio": _clamp(_safe_float(metrics.get("trim_ratio"), CALIBRATION_TRIM_RATIO), 0.0, 0.49),
        },
    }


def _clone_profile(profile: dict[str, Any] | None) -> dict[str, Any] | None:
    if profile is None:
        return None
    return json.loads(json.dumps(profile))


def _load_persisted_calibration_profile() -> dict[str, Any] | None:
    if not CALIBRATION_PROFILE_PATH.exists():
        return None

    try:
        payload = json.loads(CALIBRATION_PROFILE_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed reading calibration profile at %s: %s", CALIBRATION_PROFILE_PATH, exc)
        return None

    return _normalize_calibration_profile(payload)


def _save_persisted_calibration_profile(profile: dict[str, Any]) -> dict[str, Any]:
    normalized = _normalize_calibration_profile(profile)
    if normalized is None:
        raise HTTPException(status_code=502, detail="Calibration profile is invalid")

    CALIBRATION_PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(CALIBRATION_PROFILE_PATH.parent),
            prefix="calibration_profile_",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            json.dump(normalized, tmp, indent=2, sort_keys=True)
            tmp.write("\n")
            tmp_path = Path(tmp.name)

        if tmp_path is None:
            raise RuntimeError("Temporary file path missing")

        os.replace(tmp_path, CALIBRATION_PROFILE_PATH)
    finally:
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass

    logger.info("Persisted calibration profile to %s", CALIBRATION_PROFILE_PATH)
    return normalized


def _activate_calibration_profile(
    profile: dict[str, Any],
    *,
    effective_from_ns: int | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    global active_calibration_profile, calibration_effective_from_ns, calibration_last_processed_ns
    global calibration_last_error, calibration_last_result

    normalized = _normalize_calibration_profile(profile)
    if normalized is None:
        raise HTTPException(status_code=502, detail="Calibration profile is invalid")

    effective_ns = effective_from_ns if effective_from_ns is not None else max(0, _safe_int(normalized.get("effective_from_ns", 0), 0))
    if effective_ns <= 0:
        effective_ns = time.time_ns()

    normalized["effective_from_ns"] = effective_ns

    with calibration_lock:
        active_calibration_profile = _clone_profile(normalized)
        calibration_effective_from_ns = effective_ns
        calibration_last_processed_ns = effective_ns
        calibration_last_error = None
        calibration_last_result = {
            "ok": True,
            "message": message or "Calibration profile active",
            "at_utc": _utc_now_iso(),
        }

    logger.info("Activated backend calibration profile effective_from_ns=%d", effective_ns)
    return normalized


def _deactivate_calibration_profile(error_message: str) -> None:
    global calibration_last_error

    with calibration_lock:
        calibration_last_error = error_message


def _set_rewrite_pause_until_ns(until_ns: int) -> int:
    global calibration_rewrite_pause_until_ns

    target = max(0, int(until_ns))
    with calibration_lock:
        calibration_rewrite_pause_until_ns = max(calibration_rewrite_pause_until_ns, target)
        return calibration_rewrite_pause_until_ns


def _clear_rewrite_pause() -> None:
    global calibration_rewrite_pause_until_ns

    with calibration_lock:
        calibration_rewrite_pause_until_ns = 0


def _pause_rewrite_for(window_seconds: float) -> int:
    guard_seconds = max(0.0, CALIBRATION_CAPTURE_GUARD_SECONDS)
    total_seconds = max(0.0, float(window_seconds)) + guard_seconds
    until_ns = time.time_ns() + int(total_seconds * 1_000_000_000)
    return _set_rewrite_pause_until_ns(until_ns)


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(sum(values)) / float(len(values))


def _stddev(values: list[float]) -> float:
    if not values:
        return 0.0
    m = _mean(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / float(len(values)))


def _trimmed_mean(values: list[float], trim_ratio: float) -> float:
    if not values:
        return 0.0

    clamped_ratio = _clamp(trim_ratio, 0.0, 0.49)
    if clamped_ratio <= 0.0 or len(values) < 5:
        return _mean(values)

    ordered = sorted(values)
    trim_count = int(len(ordered) * clamped_ratio)
    if trim_count <= 0 or (trim_count * 2) >= len(ordered):
        return _mean(ordered)

    return _mean(ordered[trim_count:-trim_count])


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    p = _clamp(percentile, 0.0, 1.0)
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * p))
    return float(ordered[idx])


def _angle_delta_deg(current: float, previous: float) -> float:
    delta = current - previous
    while delta >= 180.0:
        delta -= 360.0
    while delta < -180.0:
        delta += 360.0
    return delta


def _series_deltas(values: list[float], *, wrapped_angles: bool) -> list[float]:
    if len(values) < 2:
        return []
    deltas: list[float] = []
    for idx in range(1, len(values)):
        if wrapped_angles:
            deltas.append(_angle_delta_deg(values[idx], values[idx - 1]))
        else:
            deltas.append(values[idx] - values[idx - 1])
    return deltas


def _required_calibration_samples(window_seconds: float) -> int:
    floor = max(10, CALIBRATION_MIN_SAMPLES_FLOOR)
    dynamic = int(round(max(0.0, window_seconds) * max(0.1, CALIBRATION_MIN_SAMPLE_RATE_HZ)))
    return max(floor, min(CALIBRATION_MIN_SAMPLES, dynamic))


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


def _query_imu(query: str):
    try:
        client = get_client()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected backend error: {exc}") from exc

    try:
        return client.query(query=query, language="sql")
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
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Influx query failed: {exc}") from exc


def _read_imu_rows_from_arrow(arrow_table) -> list[dict[str, Any]]:
    row_count = getattr(arrow_table, "num_rows", 0)
    column_names = set(getattr(arrow_table, "column_names", []))
    has_profile_signature = CALIBRATION_PROFILE_SIGNATURE_FIELD in column_names
    rows: list[dict[str, Any]] = []

    for i in range(row_count):
        raw_time = _read_arrow_scalar(arrow_table, "time", i)
        time_ns = _raw_time_to_epoch_ns(raw_time)
        if time_ns is None:
            continue

        try:
            row = {
                "time_ns": int(time_ns),
                "x": float(_read_arrow_scalar(arrow_table, "x", i)),
                "y": float(_read_arrow_scalar(arrow_table, "y", i)),
                "z": float(_read_arrow_scalar(arrow_table, "z", i)),
                "roll": float(_read_arrow_scalar(arrow_table, "roll", i)),
                "pitch": float(_read_arrow_scalar(arrow_table, "pitch", i)),
                "yaw": float(_read_arrow_scalar(arrow_table, "yaw", i)),
                "calibration_profile_signature": 0,
            }
            if has_profile_signature:
                row["calibration_profile_signature"] = _safe_int(
                    _read_arrow_scalar(arrow_table, CALIBRATION_PROFILE_SIGNATURE_FIELD, i),
                    0,
                )
            rows.append(row)
        except Exception:
            continue

    rows.sort(key=lambda row: row["time_ns"])
    return rows


def _query_recent_window_rows(
    window_seconds: float,
    *,
    max_rows: int = 5000,
    include_profile_signature: bool = False,
    raw_only: bool = False,
    strict_recent: bool = False,
) -> list[dict[str, Any]]:
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    device_literal = _sql_string_literal(INFLUX_DEVICE_TAG)
    window_seconds = _clamp(window_seconds, CALIBRATION_WINDOW_SECONDS_MIN, CALIBRATION_WINDOW_SECONDS_MAX)
    selected_fields = "time, x, y, z, roll, pitch, yaw"
    if include_profile_signature:
        selected_fields += f", {_sql_identifier(CALIBRATION_PROFILE_SIGNATURE_FIELD)}"

    query_window = (
        f"SELECT {selected_fields} "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        f"AND time >= now() - INTERVAL '{window_seconds} second' "
        "ORDER BY time ASC"
    )

    # Fallback for inconsistent INTERVAL support.
    query_fallback = (
        f"SELECT {selected_fields} "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        "ORDER BY time DESC "
        f"LIMIT {max_rows}"
    )

    now_ns = time.time_ns()
    cutoff_ns = now_ns - int(window_seconds * 1_000_000_000)
    future_skew_ns = int(max(0.0, CALIBRATION_MAX_FUTURE_SKEW_SECONDS) * 1_000_000_000)
    upper_ns = now_ns + future_skew_ns

    try:
        table = _query_imu(query_window)
        rows = _read_imu_rows_from_arrow(table)
    except HTTPException as exc:
        # Marker field may not exist yet in older data/schema; retry without marker.
        if include_profile_signature and CALIBRATION_PROFILE_SIGNATURE_FIELD in str(exc.detail):
            return _query_recent_window_rows(
                window_seconds,
                max_rows=max_rows,
                include_profile_signature=False,
            )
        try:
            table = _query_imu(query_fallback)
            rows = _read_imu_rows_from_arrow(table)
        except HTTPException as fallback_exc:
            if include_profile_signature and CALIBRATION_PROFILE_SIGNATURE_FIELD in str(fallback_exc.detail):
                return _query_recent_window_rows(
                    window_seconds,
                    max_rows=max_rows,
                    include_profile_signature=False,
                )
            raise

    filtered = [
        row
        for row in rows
        if cutoff_ns <= row["time_ns"] <= upper_ns
    ]
    if raw_only:
        filtered = [
            row
            for row in filtered
            if _safe_int(row.get("calibration_profile_signature"), 0) == 0
        ]

    if strict_recent and not filtered and rows:
        latest_ns = max(row["time_ns"] for row in rows)
        if latest_ns > upper_ns:
            latest_iso = datetime.fromtimestamp(latest_ns / 1_000_000_000, tz=timezone.utc).isoformat()
            now_iso = datetime.fromtimestamp(now_ns / 1_000_000_000, tz=timezone.utc).isoformat()
            raise HTTPException(
                status_code=422,
                detail=(
                    "Latest IMU points are far in the future and were excluded from calibration "
                    f"(latest={latest_iso}, now={now_iso}, max_future_skew_s={CALIBRATION_MAX_FUTURE_SKEW_SECONDS}). "
                    "Use fresh raw IMU data near current time."
                ),
            )

    filtered.sort(key=lambda row: row["time_ns"])
    return filtered


def _query_rewrite_candidates(after_ns: int, *, batch_size: int) -> list[dict[str, Any]]:
    now_ns = time.time_ns()
    delta_s = int(max(2, min(600, ((now_ns - after_ns) // 1_000_000_000) + 5)))
    rows = _query_recent_window_rows(
        float(delta_s),
        max_rows=max(4000, batch_size * 20),
        include_profile_signature=True,
        raw_only=True,
    )
    candidates = [
        row
        for row in rows
        if row["time_ns"] > after_ns
        and _safe_int(row.get("calibration_profile_signature"), 0) == 0
    ]
    candidates.sort(key=lambda row: row["time_ns"])
    return candidates[:batch_size]


def _capture_fresh_raw_window_rows(window_seconds: float) -> list[dict[str, Any]]:
    capture_window = _clamp(
        float(window_seconds),
        CALIBRATION_WINDOW_SECONDS_MIN,
        CALIBRATION_WINDOW_SECONDS_MAX,
    )
    capture_start_ns = time.time_ns()
    _pause_rewrite_for(capture_window)
    time.sleep(capture_window)
    capture_end_ns = time.time_ns()

    rows = _query_recent_window_rows(
        capture_window,
        include_profile_signature=True,
        raw_only=True,
        strict_recent=True,
    )
    upper_ns = _realtime_upper_ns(capture_end_ns)
    return [
        row
        for row in rows
        if capture_start_ns <= row["time_ns"] <= upper_ns
    ]


def _is_missing_hit_data_error(exc: HTTPException) -> bool:
    if exc.status_code == 404:
        return True

    detail = str(exc.detail).lower()
    if "no imu table" in detail:
        return True

    return "hit" in detail and any(token in detail for token in ("column", "field", "not found", "unknown"))


def _query_hit_rows(window_seconds: int):
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    device_literal = _sql_string_literal(INFLUX_DEVICE_TAG)
    query_window = (
        "SELECT time "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        "AND hit > 0 "
        f"AND time >= now() - INTERVAL '{window_seconds} second' "
        "ORDER BY time ASC"
    )

    limit = min(window_seconds * 400, 250000)
    query_fallback = (
        "SELECT time "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        "AND hit > 0 "
        "ORDER BY time DESC "
        f"LIMIT {limit}"
    )

    try:
        return _query_imu(query_window)
    except HTTPException as exc:
        if _is_missing_hit_data_error(exc):
            return None
        try:
            return _query_imu(query_fallback)
        except HTTPException as fallback_exc:
            if _is_missing_hit_data_error(fallback_exc):
                return None
            raise


def _query_latest_hit_timestamp() -> str | None:
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    device_literal = _sql_string_literal(INFLUX_DEVICE_TAG)
    query = (
        "SELECT time "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        "AND hit > 0 "
        "ORDER BY time DESC LIMIT 1"
    )

    try:
        arrow_table = _query_imu(query)
    except HTTPException as exc:
        if _is_missing_hit_data_error(exc):
            return None
        raise

    if getattr(arrow_table, "num_rows", 0) == 0:
        return None

    return _read_arrow_time_iso(arrow_table, 0)


def _build_write_url(mode: str) -> str:
    base = _normalize_url(INFLUX_URL or "").rstrip("/")
    if mode == "v3":
        params = urllib.parse.urlencode(
            {
                "db": INFLUX_DATABASE,
                "precision": "nanosecond",
                "accept_partial": "true",
                "no_sync": "true",
            }
        )
        return f"{base}/api/v3/write_lp?{params}"

    params = urllib.parse.urlencode({"db": INFLUX_DATABASE, "precision": "ns"})
    return f"{base}/api/v2/write?{params}"


def _post_lines(lines: list[str]) -> int:
    global write_mode

    if not lines:
        return 0

    body = ("\n".join(lines)).encode("utf-8")

    with write_mode_lock:
        preferred = write_mode

    modes = [preferred]
    if preferred == "v3":
        modes.append("v2")

    headers = {
        "Authorization": f"Bearer {INFLUX_TOKEN}",
        "Content-Type": "text/plain; charset=utf-8",
    }

    for mode in modes:
        url = _build_write_url(mode)
        req = urllib.request.Request(url=url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as response:
                if 200 <= response.status < 300:
                    if mode != preferred:
                        with write_mode_lock:
                            write_mode = mode
                    return len(lines)
                return 0
        except urllib.error.HTTPError as exc:
            if mode == "v3" and exc.code in (400, 404, 405):
                continue
            return 0
        except Exception:
            return 0

    return 0


def _apply_offsets_to_row(row: dict[str, Any], profile: dict[str, Any]) -> dict[str, float]:
    offsets = profile["offsets"]
    return {
        "x": row["x"] - (offsets["ax"] / ACC_SCALE_RAW),
        "y": row["y"] - (offsets["ay"] / ACC_SCALE_RAW),
        "z": row["z"] - (offsets["az"] / ACC_SCALE_RAW),
        "roll": row["roll"] - (offsets["gx"] / GYRO_SCALE_RAW),
        "pitch": row["pitch"] - (offsets["gy"] / GYRO_SCALE_RAW),
        "yaw": row["yaw"] - (offsets["gz"] / GYRO_SCALE_RAW),
    }


def _encode_calibrated_line(
    row: dict[str, Any],
    calibrated: dict[str, float],
    *,
    profile_signature: int,
) -> str:
    return (
        f"{INFLUX_MEASUREMENT},device={INFLUX_DEVICE_TAG} "
        f"x={calibrated['x']:.6f},y={calibrated['y']:.6f},z={calibrated['z']:.6f},"
        f"roll={calibrated['roll']:.6f},pitch={calibrated['pitch']:.6f},yaw={calibrated['yaw']:.6f},"
        f"{CALIBRATION_PROFILE_SIGNATURE_FIELD}={int(profile_signature)}i "
        f"{row['time_ns']}"
    )


def _compute_calibration_from_rows(rows: list[dict[str, Any]], *, window_seconds: float) -> tuple[dict[str, Any] | None, str | None]:
    required_samples = _required_calibration_samples(window_seconds)
    if len(rows) < required_samples:
        return None, (
            f"Calibration requires at least {required_samples} points "
            f"for window {window_seconds:.1f}s (got {len(rows)})"
        )

    x_values = [row["x"] for row in rows]
    y_values = [row["y"] for row in rows]
    z_values = [row["z"] for row in rows]
    roll_values = [row["roll"] for row in rows]
    pitch_values = [row["pitch"] for row in rows]
    yaw_values = [row["yaw"] for row in rows]

    magnitudes = [math.sqrt((x * x) + (y * y) + (z * z)) for x, y, z in zip(x_values, y_values, z_values)]
    accel_mag_mean = _mean(magnitudes)
    accel_mag_stddev = _stddev(magnitudes)

    trim_ratio = _clamp(CALIBRATION_TRIM_RATIO, 0.0, 0.49)
    accel_means = {
        "x": _trimmed_mean(x_values, trim_ratio),
        "y": _trimmed_mean(y_values, trim_ratio),
        "z": _trimmed_mean(z_values, trim_ratio),
    }
    gyro_means = {
        "gx": _trimmed_mean(roll_values, trim_ratio),
        "gy": _trimmed_mean(pitch_values, trim_ratio),
        "gz": _trimmed_mean(yaw_values, trim_ratio),
    }

    gyro_stddev = {
        "gx": _stddev(roll_values),
        "gy": _stddev(pitch_values),
        "gz": _stddev(yaw_values),
    }

    gyro_angle_like = any(
        abs(value) >= CALIBRATION_GYRO_ANGLE_MEAN_ABS_MIN
        for value in gyro_means.values()
    )
    gyro_deltas = {
        "gx": _series_deltas(roll_values, wrapped_angles=gyro_angle_like),
        "gy": _series_deltas(pitch_values, wrapped_angles=gyro_angle_like),
        "gz": _series_deltas(yaw_values, wrapped_angles=gyro_angle_like),
    }
    gyro_delta_abs_p95 = {
        axis: _percentile([abs(v) for v in deltas], 0.95)
        for axis, deltas in gyro_deltas.items()
    }

    if any(value > CALIBRATION_GYRO_DELTA_P95_MAX for value in gyro_delta_abs_p95.values()):
        return None, (
            "Calibration rejected: paddle moved too much "
            f"(gyro delta abs p95 {gyro_delta_abs_p95}, angle_like={gyro_angle_like})"
        )

    if not gyro_angle_like and any(value > CALIBRATION_GYRO_STDDEV_MAX for value in gyro_stddev.values()):
        return None, (
            "Calibration rejected: paddle moved too much "
            f"(gyro stddev {gyro_stddev})"
        )

    if accel_mag_mean < CALIBRATION_ACCEL_MAG_MEAN_MIN or accel_mag_mean > CALIBRATION_ACCEL_MAG_MEAN_MAX:
        return None, (
            "Calibration rejected: accelerometer magnitude outside expected range "
            f"({accel_mag_mean:.4f} g)"
        )

    if accel_mag_stddev > CALIBRATION_ACCEL_MAG_STDDEV_MAX:
        return None, (
            "Calibration rejected: accelerometer noise too high "
            f"(stddev {accel_mag_stddev:.4f} g)"
        )

    dominant_axis = max(("x", "y", "z"), key=lambda axis: abs(accel_means[axis]))
    dominant_value = accel_means[dominant_axis]
    if abs(dominant_value) < CALIBRATION_UPRIGHT_DOMINANT_AXIS_MIN:
        return None, (
            "Calibration rejected: upright orientation ambiguous "
            f"(dominant accel axis {dominant_axis}={dominant_value:.4f} g)"
        )

    accel_target = {"x": 0.0, "y": 0.0, "z": 0.0}
    accel_target[dominant_axis] = 1.0 if dominant_value >= 0.0 else -1.0

    offsets = {
        "ax": int(round((accel_means["x"] - accel_target["x"]) * ACC_SCALE_RAW)),
        "ay": int(round((accel_means["y"] - accel_target["y"]) * ACC_SCALE_RAW)),
        "az": int(round((accel_means["z"] - accel_target["z"]) * ACC_SCALE_RAW)),
        "gx": int(round(gyro_means["gx"] * GYRO_SCALE_RAW)),
        "gy": int(round(gyro_means["gy"] * GYRO_SCALE_RAW)),
        "gz": int(round(gyro_means["gz"] * GYRO_SCALE_RAW)),
    }
    profile_signature = _profile_signature_from_offsets(offsets)

    profile = {
        "version": 1,
        "created_at_utc": _utc_now_iso(),
        "effective_from_ns": time.time_ns(),
        "source": "backend_influx_window",
        "window_seconds": float(window_seconds),
        "sample_count": len(rows),
        "profile_signature": profile_signature,
        "offsets": offsets,
        "metrics": {
            "accel_magnitude_mean": accel_mag_mean,
            "accel_magnitude_stddev": accel_mag_stddev,
            "gyro_stddev": gyro_stddev,
            "gyro_delta_abs_p95": gyro_delta_abs_p95,
            "gyro_angle_like": gyro_angle_like,
            "accel_target": accel_target,
            "trim_ratio": trim_ratio,
        },
    }

    return profile, None


def _set_worker_error(message: str) -> None:
    global calibration_last_error
    with calibration_lock:
        calibration_last_error = message


def _clear_worker_error() -> None:
    global calibration_last_error
    with calibration_lock:
        calibration_last_error = None


def _rewrite_worker_loop() -> None:
    global calibration_worker_running, calibration_last_processed_ns

    with calibration_lock:
        calibration_worker_running = True

    logger.info("Calibration rewrite worker started")

    poll_s = max(0.05, CALIBRATION_REWRITE_POLL_MS / 1000.0)
    fail_s = max(0.2, CALIBRATION_REWRITE_FAIL_BACKOFF_MS / 1000.0)

    while not rewrite_worker_stop.is_set():
        with calibration_lock:
            profile = _clone_profile(active_calibration_profile)
            effective_from_ns = calibration_effective_from_ns
            last_processed_ns = calibration_last_processed_ns
            pause_until_ns = calibration_rewrite_pause_until_ns

        if profile is None or effective_from_ns is None:
            rewrite_worker_stop.wait(timeout=poll_s)
            continue

        now_ns = time.time_ns()
        if pause_until_ns > now_ns:
            wait_s = min(poll_s, max(0.01, (pause_until_ns - now_ns) / 1_000_000_000))
            rewrite_worker_stop.wait(timeout=wait_s)
            continue

        profile_signature = _safe_int(profile.get("profile_signature"), 0)
        if profile_signature <= 0:
            profile_signature = _profile_signature_from_offsets(profile.get("offsets", {}))
            profile["profile_signature"] = profile_signature

        since_ns = max(last_processed_ns or 0, effective_from_ns)

        try:
            candidates = _query_rewrite_candidates(
                after_ns=since_ns,
                batch_size=max(1, CALIBRATION_REWRITE_BATCH_SIZE),
            )
        except HTTPException as exc:
            _set_worker_error(str(exc.detail))
            rewrite_worker_stop.wait(timeout=fail_s)
            continue
        except Exception as exc:
            _set_worker_error(f"Rewrite read failed: {exc}")
            rewrite_worker_stop.wait(timeout=fail_s)
            continue

        if not candidates:
            rewrite_worker_stop.wait(timeout=poll_s)
            continue

        lines: list[str] = []
        for row in candidates:
            calibrated = _apply_offsets_to_row(row, profile)
            lines.append(
                _encode_calibrated_line(
                    row,
                    calibrated,
                    profile_signature=profile_signature,
                )
            )

        written = _post_lines(lines)
        if written != len(lines):
            _set_worker_error(
                f"Rewrite write failed (written={written}, expected={len(lines)})"
            )
            rewrite_worker_stop.wait(timeout=fail_s)
            continue

        with calibration_lock:
            calibration_last_processed_ns = int(candidates[-1]["time_ns"])

        _clear_worker_error()

    with calibration_lock:
        calibration_worker_running = False

    logger.info("Calibration rewrite worker stopped")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/calibration/status")
def get_calibration_status() -> dict[str, Any]:
    persisted_profile = _load_persisted_calibration_profile()

    with calibration_lock:
        active_profile = _clone_profile(active_calibration_profile)
        effective_from_ns = calibration_effective_from_ns
        last_processed_ns = calibration_last_processed_ns
        last_error = calibration_last_error
        last_result = dict(calibration_last_result)
        worker_running = calibration_worker_running
        pause_until_ns = calibration_rewrite_pause_until_ns

    return {
        "mode": "backend_influx",
        "active_profile": active_profile,
        "persisted_profile": persisted_profile,
        "rewrite_worker": {
            "enabled": True,
            "running": worker_running,
            "effective_from_ns": effective_from_ns,
            "last_processed_ns": last_processed_ns,
            "last_error": last_error,
            "pause_until_ns": pause_until_ns if pause_until_ns > 0 else None,
            "paused": bool(pause_until_ns > time.time_ns()),
        },
        "last_result": last_result,
    }


@app.post("/api/calibration/start")
def start_calibration(payload: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    payload = payload or {}

    requested_window = _safe_float(payload.get("window_seconds", CALIBRATION_WINDOW_SECONDS_DEFAULT))
    window_seconds = _clamp(
        requested_window,
        CALIBRATION_WINDOW_SECONDS_MIN,
        CALIBRATION_WINDOW_SECONDS_MAX,
    )
    fresh_window = bool(payload.get("fresh_window", False))

    if fresh_window:
        try:
            rows = _capture_fresh_raw_window_rows(window_seconds)
        finally:
            # Resume rewrite immediately after capture regardless of outcome.
            _clear_rewrite_pause()
    else:
        rows = _query_recent_window_rows(
            window_seconds,
            include_profile_signature=True,
            raw_only=True,
            strict_recent=True,
        )
    if not rows:
        raise HTTPException(
            status_code=404,
            detail="No IMU data found in calibration window",
        )

    profile, error_message = _compute_calibration_from_rows(rows, window_seconds=window_seconds)
    if profile is None:
        with calibration_lock:
            calibration_last_result.update(
                {
                    "ok": False,
                    "message": error_message or "Calibration rejected",
                    "at_utc": _utc_now_iso(),
                }
            )
        raise HTTPException(status_code=422, detail=error_message or "Calibration rejected")

    effective_from_ns = time.time_ns()
    profile["effective_from_ns"] = effective_from_ns
    persisted_profile = _save_persisted_calibration_profile(profile)
    active_profile = _activate_calibration_profile(
        persisted_profile,
        effective_from_ns=effective_from_ns,
        message="Calibration applied",
    )

    return {
        "ok": True,
        "message": "Calibration applied",
        "profile": active_profile,
    }


@app.post("/api/calibration/apply")
def apply_calibration() -> dict[str, Any]:
    profile = _load_persisted_calibration_profile()
    if profile is None:
        raise HTTPException(
            status_code=404,
            detail=f"No persisted calibration profile found at {CALIBRATION_PROFILE_PATH}",
        )

    effective_from_ns = time.time_ns()
    profile["effective_from_ns"] = effective_from_ns
    persisted = _save_persisted_calibration_profile(profile)

    active_profile = _activate_calibration_profile(
        persisted,
        effective_from_ns=effective_from_ns,
        message="Persisted calibration applied",
    )

    return {
        "ok": True,
        "message": "Persisted calibration applied",
        "profile": active_profile,
    }


@app.get("/api/imu/latest")
def get_latest_imu() -> dict[str, Any]:
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    device_literal = _sql_string_literal(INFLUX_DEVICE_TAG)
    query = (
        "SELECT time, x, y, z, roll, pitch, yaw "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        "ORDER BY time DESC LIMIT 5000"
    )

    arrow_table = _query_imu(query)
    rows = _read_imu_rows_from_arrow(arrow_table)
    if not rows:
        raise HTTPException(status_code=404, detail="No IMU data found")

    realtime_rows = _filter_rows_to_realtime(rows)
    if not realtime_rows:
        latest_ns = max(row["time_ns"] for row in rows)
        latest_iso = _epoch_ns_to_iso(latest_ns)
        now_iso = _utc_now_iso()
        raise HTTPException(
            status_code=404,
            detail=(
                "No IMU data found near current time. "
                f"Latest point is in the future (latest={latest_iso}, now={now_iso})."
            ),
        )

    row = realtime_rows[-1]
    missing_fields = sorted(list(EXPECTED_FIELDS - set(row.keys())))
    if missing_fields:
        raise HTTPException(
            status_code=404,
            detail=f"IMU data is incomplete. Missing fields: {', '.join(missing_fields)}",
        )

    timestamp = _epoch_ns_to_iso(int(row["time_ns"]))

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
def get_all_imu(limit: int | None = Query(default=None, ge=1, le=2000)) -> dict[str, Any]:
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    device_literal = _sql_string_literal(INFLUX_DEVICE_TAG)
    requested_limit = limit if limit is not None else 2000
    query_limit = min(20000, max(2000, requested_limit * 5))
    query = (
        "SELECT time, x, y, z, roll, pitch, yaw "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        "ORDER BY time DESC "
        f"LIMIT {query_limit}"
    )

    arrow_table = _query_imu(query)
    rows = _read_imu_rows_from_arrow(arrow_table)
    rows = _filter_rows_to_realtime(rows)
    if not rows:
        return {"count": 0, "entries": []}

    rows.sort(key=lambda row: row["time_ns"], reverse=True)
    rows = rows[:requested_limit]

    entries: list[dict[str, Any]] = []
    for row in rows:
        entries.append(
            {
                "timestamp": _epoch_ns_to_iso(int(row["time_ns"])),
                "x": row["x"],
                "y": row["y"],
                "z": row["z"],
                "roll": row["roll"],
                "pitch": row["pitch"],
                "yaw": row["yaw"],
            }
        )

    return {"count": len(entries), "entries": entries}


@app.get("/api/imu/throughput")
def get_imu_throughput(window_seconds: int = 60) -> dict[str, Any]:
    window_seconds = max(10, min(window_seconds, 600))
    table_name = _sql_identifier(INFLUX_MEASUREMENT)
    device_literal = _sql_string_literal(INFLUX_DEVICE_TAG)

    query_window = (
        "SELECT time "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
        f"AND time >= now() - INTERVAL '{window_seconds} second' "
        f"AND time <= now() + INTERVAL '{CALIBRATION_MAX_FUTURE_SKEW_SECONDS} second' "
        "ORDER BY time ASC"
    )

    limit = min(window_seconds * 400, 250000)
    query_fallback = (
        "SELECT time "
        f"FROM {table_name} "
        f"WHERE device = {device_literal} "
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


@app.get("/api/imu/hits/summary")
def get_hit_summary(window_seconds: int = 60) -> dict[str, Any]:
    window_seconds = max(10, min(window_seconds, 600))
    now_epoch = int(datetime.now(tz=timezone.utc).timestamp())
    cutoff_epoch = now_epoch - window_seconds

    arrow_table = _query_hit_rows(window_seconds)
    hits_in_window = 0

    if arrow_table is not None:
        row_count = getattr(arrow_table, "num_rows", 0)
        for i in range(row_count):
            raw = _read_arrow_scalar(arrow_table, "time", i)
            dt = _raw_time_to_datetime_utc(raw)
            if dt is None:
                continue
            if int(dt.timestamp()) >= cutoff_epoch:
                hits_in_window += 1

    latest_hit_timestamp = _query_latest_hit_timestamp()
    rolling_hps = round(float(hits_in_window) / float(window_seconds), 4)

    return {
        "window_seconds": window_seconds,
        "hits_in_window": hits_in_window,
        "rolling_hps": rolling_hps,
        "latest_hit_timestamp": latest_hit_timestamp,
    }


@app.on_event("startup")
def startup() -> None:
    global rewrite_worker_thread

    persisted = _load_persisted_calibration_profile()
    if persisted is not None:
        now_ns = time.time_ns()
        try:
            _activate_calibration_profile(
                persisted,
                effective_from_ns=now_ns,
                message="Loaded persisted calibration profile",
            )
        except HTTPException as exc:
            logger.warning("Unable to activate persisted calibration profile: %s", exc.detail)

    rewrite_worker_stop.clear()
    rewrite_worker_thread = threading.Thread(
        target=_rewrite_worker_loop,
        name="calibration-rewrite-worker",
        daemon=True,
    )
    rewrite_worker_thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    global _client

    rewrite_worker_stop.set()
    if rewrite_worker_thread is not None:
        rewrite_worker_thread.join(timeout=2.0)

    if _client is not None:
        _client.close()
        _client = None


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
