from arduino.app_utils import *
from influx_discovery import pick_influx_url
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

logger = Logger("influxdb-accelerometer")

INFLUX_TOKEN = "apiv3_3HZwgr6nbojXXu0kj51rJDktCrsa6zs29OpN81Ad3k6VObc8VKaDeHFGQ6Nk_Da5sSunccdyvsDnHvtF-gIlIw"
INFLUX_DATABASE = "imu_data"
INFLUX_MEASUREMENT = "imu_data"
INFLUX_URL = pick_influx_url(logger, INFLUX_TOKEN)

# Set True to bypass DB writes and only measure bridge throughput.
DISABLE_INFLUX = False

QUEUE_MAX_SIZE = 16384
BATCH_SIZE = 400
FLUSH_INTERVAL_S = 0.50
HTTP_TIMEOUT_S = 2.0

ACC_SCALE = 1000.0
GYRO_SCALE = 10.0

samples = queue.Queue(maxsize=QUEUE_MAX_SIZE)
stop_event = threading.Event()

stats_lock = threading.Lock()
callback_count = 0
rx_count = 0
written_count = 0
dropped_count = 0
failed_count = 0
last_log = time.time()

write_mode_lock = threading.Lock()
# Start with v3 native line-protocol endpoint, fallback to v2 compatibility if needed.
write_mode = "v3"


def _encode_line(sample):
    ax, ay, az, gx, gy, gz, ts_ns, hit = sample
    x = float(ax) / ACC_SCALE
    y = float(ay) / ACC_SCALE
    z = float(az) / ACC_SCALE
    roll = float(gx) / GYRO_SCALE
    pitch = float(gy) / GYRO_SCALE
    yaw = float(gz) / GYRO_SCALE
    hit_flag = 1 if int(hit) != 0 else 0
    return (
        f"{INFLUX_MEASUREMENT},device=arduino_uno_q "
        f"x={x:.6f},y={y:.6f},z={z:.6f},roll={roll:.6f},pitch={pitch:.6f},yaw={yaw:.6f},hit={hit_flag}i {ts_ns}"
    )


def _build_write_url(mode):
    base = INFLUX_URL.rstrip("/")
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


def _post_lines(lines):
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
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
                if 200 <= resp.status < 300:
                    if mode != preferred:
                        with write_mode_lock:
                            write_mode = mode
                        logger.warning(f"Switched Influx write mode to {mode}")
                    return len(lines)
                logger.error(f"Influx write returned HTTP {resp.status}")
                return 0
        except urllib.error.HTTPError as exc:
            # Fallback when v3 endpoint is unavailable.
            if mode == "v3" and exc.code in (400, 404, 405):
                continue
            logger.error(f"Influx write HTTPError {exc.code}: {exc.reason}")
            return 0
        except Exception as exc:
            logger.error(f"Influx write exception: {exc}")
            return 0

    logger.error("Influx write failed on all supported endpoints")
    return 0


def _write_batch(batch):
    if DISABLE_INFLUX:
        return len(batch)
    return _post_lines([_encode_line(sample) for sample in batch])


def _writer_loop():
    global written_count, failed_count

    batch = []
    last_flush = time.monotonic()

    while not stop_event.is_set():
        timeout = FLUSH_INTERVAL_S - (time.monotonic() - last_flush)
        if timeout < 0.0:
            timeout = 0.0

        try:
            sample = samples.get(timeout=timeout)
            batch.append(sample)
        except queue.Empty:
            pass

        now = time.monotonic()
        if batch and (len(batch) >= BATCH_SIZE or (now - last_flush) >= FLUSH_INTERVAL_S):
            written = _write_batch(batch)
            with stats_lock:
                written_count += written
                failed_count += (len(batch) - written)
            batch.clear()
            last_flush = now

    while True:
        try:
            batch.append(samples.get_nowait())
        except queue.Empty:
            break

    if batch:
        written = _write_batch(batch)
        with stats_lock:
            written_count += written
            failed_count += (len(batch) - written)


def _enqueue_samples(items):
    global rx_count, dropped_count

    dropped_local = 0
    for item in items:
        try:
            samples.put_nowait(item)
        except queue.Full:
            try:
                samples.get_nowait()
            except queue.Empty:
                pass
            try:
                samples.put_nowait(item)
            except queue.Full:
                pass
            dropped_local += 1

    with stats_lock:
        rx_count += len(items)
        dropped_count += dropped_local


def _log_rates_if_needed():
    global callback_count, rx_count, written_count, dropped_count, failed_count, last_log

    now = time.time()
    if now - last_log < 1.0:
        return

    with stats_lock:
        if now - last_log < 1.0:
            return

        cb = callback_count
        rx = rx_count
        wr = written_count
        dr = dropped_count
        fl = failed_count
        callback_count = 0
        rx_count = 0
        written_count = 0
        dropped_count = 0
        failed_count = 0
        last_log = now

    logger.info(
        f"callbacks/s={cb} samples_rx/s={rx} written/s={wr} dropped/s={dr} failed/s={fl} queued={samples.qsize()}"
    )


def _parse_one(ax, ay, az, gx, gy, gz):
    return int(ax), int(ay), int(az), int(gx), int(gy), int(gz)


def record_sensor_movement(ax, ay, az, gx, gy, gz):
    global callback_count, failed_count

    try:
        raw_ax, raw_ay, raw_az, raw_gx, raw_gy, raw_gz = _parse_one(ax, ay, az, gx, gy, gz)
    except Exception:
        with stats_lock:
            failed_count += 1
        return

    with stats_lock:
        callback_count += 1
    _enqueue_samples([(raw_ax, raw_ay, raw_az, raw_gx, raw_gy, raw_gz, time.time_ns(), 0)])
    _log_rates_if_needed()


def record_sensor_movement_batch(payload):
    global callback_count, failed_count

    with stats_lock:
        callback_count += 1

    if payload is None:
        with stats_lock:
            failed_count += 1
        return

    text = payload.decode("utf-8", errors="ignore") if isinstance(payload, (bytes, bytearray)) else str(payload)
    rows = text.split(";")
    ts = time.time_ns()

    parsed = []
    parse_fail = 0
    for idx, row in enumerate(rows):
        if not row:
            continue
        parts = row.split(",")
        if len(parts) not in (6, 7, 8):
            parse_fail += 1
            continue

        try:
            raw_ax, raw_ay, raw_az, raw_gx, raw_gy, raw_gz = _parse_one(
                parts[0],
                parts[1],
                parts[2],
                parts[3],
                parts[4],
                parts[5],
            )
            if len(parts) >= 7:
                int(parts[6])
            hit = 0
            if len(parts) == 8:
                hit = 1 if int(parts[7]) != 0 else 0
        except Exception:
            parse_fail += 1
            continue

        parsed.append((raw_ax, raw_ay, raw_az, raw_gx, raw_gy, raw_gz, ts + idx, hit))

    if parse_fail:
        with stats_lock:
            failed_count += parse_fail

    if parsed:
        _enqueue_samples(parsed)

    _log_rates_if_needed()


writer_thread = threading.Thread(target=_writer_loop, name="influx-writer", daemon=True)
writer_thread.start()

try:
    Bridge.provide("imu", record_sensor_movement)
except RuntimeError:
    pass

try:
    Bridge.provide("imu_batch", record_sensor_movement_batch)
    logger.info("'imu_batch' registered")
except RuntimeError:
    logger.debug("'imu_batch' already registered")

try:
    App.run()
finally:
    stop_event.set()

    writer_thread.join(timeout=2.0)
