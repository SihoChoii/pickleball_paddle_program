import { initPaddle3D, updatePaddleIMU } from "./paddle-3d.js";

const els = {
  status: document.querySelector("#status"),
  sampleTime: document.querySelector("#sample-time"),
  dataRate: document.querySelector("#data-rate"),
  dataRateAvg: document.querySelector("#data-rate-avg"),
  historyCount: document.querySelector("#history-count"),
  historyBody: document.querySelector("#history-body"),
  accelX: document.querySelector("#accel-x"),
  accelY: document.querySelector("#accel-y"),
  accelZ: document.querySelector("#accel-z"),
  gyroRoll: document.querySelector("#gyro-roll"),
  gyroPitch: document.querySelector("#gyro-pitch"),
  gyroYaw: document.querySelector("#gyro-yaw"),
  throughputChart: document.querySelector("#throughput-chart"),
};

const LATEST_API_URL = "/api/imu/latest";
const ALL_API_URL = "/api/imu/all";
const THROUGHPUT_API_URL = "/api/imu/throughput?window_seconds=60";
const LATEST_POLL_MS = 250;
const HISTORY_POLL_MS = 3000;
const THROUGHPUT_POLL_MS = 1000;

const throughputState = { points: [] };

function fmt(value) {
  return Number(value).toFixed(4);
}

// ─── Throughput Chart ────────────────────────────────────────────────────────

function drawThroughputChart() {
  if (!els.throughputChart) return;
  const points = throughputState.points;
  const canvas = els.throughputChart;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const left = 42, right = width - 10, top = 12, bottom = height - 26;
  const chartWidth = right - left, chartHeight = bottom - top;

  ctx.strokeStyle = "#d8e2ef";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();

  const maxCount = Math.max(10, ...points.map((p) => p.count));
  const gridSteps = 4;
  ctx.strokeStyle = "#edf2f8";
  ctx.fillStyle = "#4c5f79";
  ctx.font = "11px IBM Plex Sans, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= gridSteps; i++) {
    const y = top + (i / gridSteps) * chartHeight;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(maxCount * (1 - i / gridSteps))), left - 6, y);
  }

  if (!points.length) {
    ctx.fillStyle = "#6d7f98";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No throughput data yet", width / 2, height / 2);
    return;
  }

  ctx.strokeStyle = "#007f8c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, i) => {
    const x = points.length === 1
      ? left + chartWidth / 2
      : left + (i / (points.length - 1)) * chartWidth;
    const y = bottom - (point.count / maxCount) * chartHeight;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#007f8c";
  const lastPoint = points[points.length - 1];
  const lastX = left + chartWidth;
  const lastY = bottom - (lastPoint.count / maxCount) * chartHeight;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#4c5f79";
  ctx.font = "11px IBM Plex Sans, Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("-60s", left, bottom + 6);
  ctx.textAlign = "right";
  ctx.fillText("now", right, bottom + 6);
}

// ─── API Fetchers ─────────────────────────────────────────────────────────────

async function fetchThroughput() {
  try {
    const res = await fetch(THROUGHPUT_API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    throughputState.points = Array.isArray(payload.points) ? payload.points : [];
    els.dataRate.textContent = String(Number(payload.latest_complete_dps ?? 0));
    els.dataRateAvg.textContent = Number(payload.average_dps ?? 0).toFixed(2);
    drawThroughputChart();
  } catch { /* keep live */ }
}

async function fetchLatestImu() {
  try {
    const res = await fetch(LATEST_API_URL);
    if (!res.ok) {
      let detail = "";
      try { const e = await res.json(); detail = e?.detail ? ` - ${e.detail}` : ""; } catch {}
      throw new Error(`HTTP ${res.status}${detail}`);
    }

    const payload = await res.json();
    const { acceleration, gyroscope, timestamp } = payload;

    els.accelX.textContent = fmt(acceleration.x);
    els.accelY.textContent = fmt(acceleration.y);
    els.accelZ.textContent = fmt(acceleration.z);
    els.gyroRoll.textContent = fmt(gyroscope.roll);
    els.gyroPitch.textContent = fmt(gyroscope.pitch);
    els.gyroYaw.textContent = fmt(gyroscope.yaw);

    els.status.textContent = "Connected";
    els.status.classList.add("connected");
    els.sampleTime.textContent = timestamp ?? "-";

    // 🏓 Feed 3D paddle
    updatePaddleIMU({
      roll:  gyroscope.roll,
      pitch: gyroscope.pitch,
      yaw:   gyroscope.yaw,
      x: acceleration.x,
      y: acceleration.y,
      z: acceleration.z,
    });
  } catch (error) {
    els.status.textContent = `Waiting for IMU data (${error.message})`;
    els.status.classList.remove("connected");
  }
}

function renderHistory(entries) {
  if (!entries.length) {
    els.historyBody.innerHTML = '<tr><td colspan="7">No data yet.</td></tr>';
    return;
  }
  els.historyBody.innerHTML = entries.map(
    (row) => `<tr>
      <td>${row.timestamp ?? "-"}</td>
      <td>${fmt(row.x)}</td><td>${fmt(row.y)}</td><td>${fmt(row.z)}</td>
      <td>${fmt(row.roll)}</td><td>${fmt(row.pitch)}</td><td>${fmt(row.yaw)}</td>
    </tr>`
  ).join("");
}

async function fetchAllImu() {
  try {
    const res = await fetch(ALL_API_URL);
    if (!res.ok) return;
    const payload = await res.json();
    els.historyCount.textContent = String(payload.count ?? 0);
    renderHistory(payload.entries ?? []);
  } catch {}
}

// ─── Init ─────────────────────────────────────────────────────────────────────

drawThroughputChart();
fetchLatestImu();
fetchAllImu();
fetchThroughput();

// Init 3D paddle
initPaddle3D("#paddle-canvas");

setInterval(fetchLatestImu, LATEST_POLL_MS);
setInterval(fetchAllImu, HISTORY_POLL_MS);
setInterval(fetchThroughput, THROUGHPUT_POLL_MS);
