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
