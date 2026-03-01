# Pickleball Paddle Program

Test project skeleton to read IMU data from InfluxDB and display it in a frontend.

## Project Structure

```
backend/
  app/main.py            # FastAPI backend + InfluxDB query endpoint
  requirements.txt       # Python dependencies
  .env.example           # Environment variable template
frontend/
  index.html             # Test frontend page
  styles.css             # Basic styling
  app.js                 # Polls backend and prints IMU data
```

## 1. Configure Environment

Copy the template and fill in your Influx settings:

```bash
cp backend/.env.example backend/.env
```

Set:
- `INFLUX_URL` (InfluxDB 3 Core default: `http://<influx-host>:8181`)
- `INFLUX_TOKEN`
- `INFLUX_DATABASE`
- optionally `INFLUX_MEASUREMENT` (default: `imu_data`)
- optionally backend calibration tuning values from `backend/.env.example`

Notes:
- This skeleton is configured for InfluxDB 3 Core (`influxdb3`).
- If your writer still uses `INFLUX_BUCKET`, backend will use that as a fallback database name.

## 2. Install Dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

## 3. Run

```bash
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Open:

- http://localhost:8000

## API

- `GET /api/imu/latest`
  - Returns latest `x, y, z, roll, pitch, yaw` from InfluxDB.
- `GET /api/imu/all`
  - Returns all rows in the IMU measurement (newest first) for debug display.
- `GET /api/imu/hits/summary?window_seconds=60`
  - Returns hit metrics from `imu_data`:
    - `hits_in_window`
    - `rolling_hps`
    - `latest_hit_timestamp`
- `GET /api/calibration/status`
  - Returns backend calibration mode/profile/worker status.
- `POST /api/calibration/start`
  - Builds calibration profile from recent Influx points and activates rewrite mode.
  - Optional payload flag `fresh_window=true` captures a fresh raw window by pausing rewrite during capture.
- `POST /api/calibration/apply`
  - Re-applies persisted calibration profile in backend rewrite mode.

## Backend Calibration Mode

- Calibration is backend-only and does not depend on board LAN control APIs.
- When active, backend rewrite worker rewrites only future points in `imu_data` with calibrated values.
- Existing historical rows before activation are kept unchanged.
- Minimum calibration points are window-aware (`CALIBRATION_MIN_SAMPLE_RATE_HZ` with floor `CALIBRATION_MIN_SAMPLES_FLOOR`, capped by `CALIBRATION_MIN_SAMPLES`).
- Rewrite is idempotent per profile via an internal `cal_profile_sig` field to avoid repeated offset application on retry paths.
- Upright calibration keeps a 1g rest target on the dominant accelerometer axis (instead of zeroing gravity).
- Gyro stillness rejection uses wrapped per-sample delta noise (`CALIBRATION_GYRO_DELTA_P95_MAX`) so orientation drift/angle wrap is less likely to trigger false "moved too much".
- Calibration sampling uses uncalibrated rows only and ignores far-future timestamps (`CALIBRATION_MAX_FUTURE_SKEW_SECONDS`) to avoid using corrupted/replayed points.
- Frontend calibration uses fresh-window capture (`fresh_window=true`) so an active rewrite profile does not starve raw sample count.

## IMU Batch Payload

- Firmware batch rows now include an optional hit flag:
  - `ax,ay,az,gx,gy,gz,seq,hit`
- Backward compatibility:
  - Legacy payloads with 6 or 7 columns are still accepted by the bridge writer.
  - Missing `hit` values default to `0`.
