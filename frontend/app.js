const els = {
  status: document.querySelector("#status"),
  sampleTime: document.querySelector("#sample-time"),
  dataRate: document.querySelector("#data-rate"),
  dataRateAvg: document.querySelector("#data-rate-avg"),
  historyCount: document.querySelector("#history-count"),
  historyBody: document.querySelector("#history-body"),
  historyShowMore: document.querySelector("#history-show-more"),
  historyReset: document.querySelector("#history-reset"),
  accelX: document.querySelector("#accel-x"),
  accelY: document.querySelector("#accel-y"),
  accelZ: document.querySelector("#accel-z"),
  gyroRoll: document.querySelector("#gyro-roll"),
  gyroPitch: document.querySelector("#gyro-pitch"),
  gyroYaw: document.querySelector("#gyro-yaw"),
  throughputChart: document.querySelector("#throughput-chart"),
  calibrationStart: document.querySelector("#calibration-start"),
  calibrationApply: document.querySelector("#calibration-apply"),
  calibrationCountdown: document.querySelector("#calibration-countdown"),
  calibrationStatus: document.querySelector("#calibration-status"),
  calibrationLast: document.querySelector("#calibration-last"),
  hitLatestTime: document.querySelector("#hit-latest-time"),
  hitWindowCount: document.querySelector("#hit-window-count"),
  hitRate: document.querySelector("#hit-rate"),
};

const LATEST_API_URL = "/api/imu/latest";
const ALL_API_URL = "/api/imu/all";
const THROUGHPUT_API_URL = "/api/imu/throughput?window_seconds=60";
const HIT_SUMMARY_API_URL = "/api/imu/hits/summary?window_seconds=60";
const CALIBRATION_STATUS_API_URL = "/api/calibration/status";
const CALIBRATION_START_API_URL = "/api/calibration/start";
const CALIBRATION_APPLY_API_URL = "/api/calibration/apply";

const LATEST_POLL_MS = 250;
const HISTORY_POLL_MS = 3000;
const THROUGHPUT_POLL_MS = 1000;
const HIT_SUMMARY_POLL_MS = 1000;
const CALIBRATION_STATUS_POLL_MS = 2000;
const CALIBRATION_COUNTDOWN_SECONDS = 8;
const CALIBRATION_WINDOW_SECONDS = 8;
const CALIBRATION_FRESH_WINDOW = true;

const HISTORY_PAGE_SIZE = 200;
const HISTORY_LIMIT_MAX = 2000;

const throughputState = {
  points: [],
};
const historyState = {
  limit: HISTORY_PAGE_SIZE,
  entryCount: 0,
  lastSignature: "",
};
const calibrationState = {
  localBusy: false,
  statusLockUntilMs: 0,
};

function fmt(value) {
  return Number(value).toFixed(4);
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function readErrorMessage(res, fallback) {
  try {
    const payload = await res.json();
    if (payload?.detail) return String(payload.detail);
    if (payload?.message) return String(payload.message);
  } catch {
    // ignore non-json errors
  }
  return fallback;
}

function setCalibrationStatus(message, tone = "info") {
  if (!els.calibrationStatus) return;

  els.calibrationStatus.textContent = message;
  els.calibrationStatus.classList.remove(
    "calibration-status-info",
    "calibration-status-success",
    "calibration-status-error"
  );

  if (tone === "success") {
    els.calibrationStatus.classList.add("calibration-status-success");
  } else if (tone === "error") {
    els.calibrationStatus.classList.add("calibration-status-error");
  } else {
    els.calibrationStatus.classList.add("calibration-status-info");
  }
}

function setCalibrationStatusWithLock(message, tone = "info", lockMs = 0) {
  setCalibrationStatus(message, tone);
  if (lockMs > 0) {
    calibrationState.statusLockUntilMs = Date.now() + lockMs;
  }
}

function isCalibrationStatusLocked() {
  return Date.now() < calibrationState.statusLockUntilMs;
}

function updateCalibrationButtons() {
  const disabled = calibrationState.localBusy;

  if (els.calibrationStart) {
    els.calibrationStart.disabled = disabled;
  }
  if (els.calibrationApply) {
    els.calibrationApply.disabled = disabled;
  }
}

function drawThroughputChart() {
  if (!els.throughputChart) return;

  const points = throughputState.points;
  const canvas = els.throughputChart;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const left = 42;
  const right = width - 10;
  const top = 12;
  const bottom = height - 26;
  const chartWidth = right - left;
  const chartHeight = bottom - top;

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

    const label = Math.round(maxCount * (1 - i / gridSteps));
    ctx.fillText(String(label), left - 6, y);
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
    const x =
      points.length === 1
        ? left + chartWidth / 2
        : left + (i / (points.length - 1)) * chartWidth;
    const y = bottom - (point.count / maxCount) * chartHeight;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
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

async function fetchThroughput() {
  try {
    const res = await fetch(THROUGHPUT_API_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const payload = await res.json();
    throughputState.points = Array.isArray(payload.points) ? payload.points : [];

    const latestComplete = Number(payload.latest_complete_dps ?? 0);
    const avg = Number(payload.average_dps ?? 0);

    els.dataRate.textContent = String(latestComplete);
    els.dataRateAvg.textContent = avg.toFixed(2);
    drawThroughputChart();
  } catch {
    // Keep main data path live even when throughput endpoint fails.
  }
}

async function fetchHitSummary() {
  try {
    const res = await fetch(HIT_SUMMARY_API_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const payload = await res.json();
    const hitsInWindow = Number(payload.hits_in_window ?? 0);
    const rollingHps = Number(payload.rolling_hps ?? 0);
    const latestHitTimestamp = payload.latest_hit_timestamp ?? "-";

    if (els.hitWindowCount) {
      els.hitWindowCount.textContent = String(hitsInWindow);
    }
    if (els.hitRate) {
      els.hitRate.textContent = rollingHps.toFixed(4);
    }
    if (els.hitLatestTime) {
      els.hitLatestTime.textContent = latestHitTimestamp;
    }
  } catch {
    // Keep existing values when endpoint is unavailable.
  }
}

async function fetchLatestImu() {
  try {
    const res = await fetch(LATEST_API_URL);
    if (!res.ok) {
      let detail = "";
      try {
        const errPayload = await res.json();
        detail = errPayload?.detail ? ` - ${errPayload.detail}` : "";
      } catch {
        // ignore parse errors for non-json responses
      }
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
    els.sampleTime.textContent = timestamp ?? "-";
  } catch (error) {
    els.status.textContent = `Waiting for IMU data (${error.message})`;
  }
}

function renderHistory(entries) {
  if (!entries.length) {
    els.historyBody.innerHTML = '<tr><td colspan="7">No data yet.</td></tr>';
    return;
  }

  const rows = entries
    .map(
      (row) => `
        <tr>
          <td>${row.timestamp ?? "-"}</td>
          <td>${fmt(row.x)}</td>
          <td>${fmt(row.y)}</td>
          <td>${fmt(row.z)}</td>
          <td>${fmt(row.roll)}</td>
          <td>${fmt(row.pitch)}</td>
          <td>${fmt(row.yaw)}</td>
        </tr>
      `
    )
    .join("");

  els.historyBody.innerHTML = rows;
}

function buildHistoryUrl() {
  return `${ALL_API_URL}?limit=${historyState.limit}`;
}

function updateHistoryMeta() {
  els.historyCount.textContent = `${historyState.entryCount} (limit ${historyState.limit})`;
}

function updateHistoryControls() {
  if (els.historyShowMore) {
    const atMaxLimit = historyState.limit >= HISTORY_LIMIT_MAX;
    const looksExhausted = historyState.entryCount < historyState.limit;
    els.historyShowMore.disabled = atMaxLimit || looksExhausted;
  }

  if (els.historyReset) {
    els.historyReset.disabled = historyState.limit === HISTORY_PAGE_SIZE;
  }
}

async function fetchAllImu() {
  try {
    const res = await fetch(buildHistoryUrl());
    if (!res.ok) {
      return;
    }
    const payload = await res.json();
    const entries = payload.entries ?? [];
    historyState.entryCount = entries.length;

    const firstTs = entries[0]?.timestamp ?? "";
    const lastTs = entries[entries.length - 1]?.timestamp ?? "";
    const signature = `${entries.length}:${firstTs}:${lastTs}`;
    if (signature !== historyState.lastSignature) {
      renderHistory(entries);
      historyState.lastSignature = signature;
    }

    updateHistoryMeta();
    updateHistoryControls();
  } catch {
    // Keep live data polling independent from history table errors.
  }
}

async function fetchCalibrationStatus() {
  if (calibrationState.localBusy || isCalibrationStatusLocked()) {
    return;
  }

  try {
    const res = await fetch(CALIBRATION_STATUS_API_URL);
    if (!res.ok) {
      const detail = await readErrorMessage(res, `HTTP ${res.status}`);
      throw new Error(detail);
    }

    const payload = await res.json();
    const mode = payload.mode;
    const activeProfile = payload.active_profile;
    const persistedProfile = payload.persisted_profile;
    const rewriteWorker = payload.rewrite_worker ?? {};
    const lastResult = payload.last_result ?? {};
    const latestProfile = activeProfile ?? persistedProfile ?? null;

    if (els.calibrationLast) {
      els.calibrationLast.textContent = latestProfile?.created_at_utc ?? "Never";
    }

    if (rewriteWorker?.last_error) {
      setCalibrationStatus(
        `Backend rewrite worker error: ${rewriteWorker.last_error}`,
        "error"
      );
      return;
    }

    if (lastResult?.message && lastResult?.ok === false) {
      const stillActive = Boolean(activeProfile);
      const suffix = stillActive
        ? " (previous calibration profile is still active)"
        : "";
      setCalibrationStatus(`${String(lastResult.message)}${suffix}`, "error");
      return;
    }

    if (activeProfile) {
      const effectiveNs = Number(
        rewriteWorker?.effective_from_ns ?? activeProfile?.effective_from_ns ?? 0
      );
      const effectiveText = Number.isFinite(effectiveNs) && effectiveNs > 0 ? String(effectiveNs) : "unknown";
      const modeText = mode ? ` (${mode})` : "";
      setCalibrationStatus(
        `Backend calibration active${modeText}. Effective from ns=${effectiveText}.`,
        "success"
      );
      return;
    }

    if (lastResult?.message) {
      setCalibrationStatus(
        String(lastResult.message),
        lastResult?.ok ? "success" : "error"
      );
      return;
    }

    setCalibrationStatus("No calibration profile active yet.", "info");
  } catch (error) {
    updateCalibrationButtons();
    setCalibrationStatus(`Calibration status error: ${error.message}`, "error");
  }
}

async function runCalibrationCountdown() {
  if (!els.calibrationCountdown) return;

  for (let remaining = CALIBRATION_COUNTDOWN_SECONDS; remaining > 0; remaining -= 1) {
    els.calibrationCountdown.textContent = `${remaining}s`;
    setCalibrationStatusWithLock(
      `Hold still... capturing (${remaining}s left)`,
      "info",
      1200
    );
    await sleep(1000);
  }

  els.calibrationCountdown.textContent = "Finalizing...";
  setCalibrationStatusWithLock("Finalizing calibration...", "info", 3000);
}

async function startCalibrationFlow() {
  if (calibrationState.localBusy) {
    return;
  }

  calibrationState.localBusy = true;
  updateCalibrationButtons();

  try {
    let res;
    await Promise.all([
      runCalibrationCountdown(),
      (async () => {
        res = await fetch(CALIBRATION_START_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            window_seconds: CALIBRATION_WINDOW_SECONDS,
            fresh_window: CALIBRATION_FRESH_WINDOW,
          }),
        });
      })(),
    ]);

    if (!res.ok) {
      const detail = await readErrorMessage(res, `HTTP ${res.status}`);
      throw new Error(detail);
    }

    const payload = await res.json();
    els.calibrationCountdown.textContent = "Done";
    setCalibrationStatusWithLock(
      payload.message ?? "Calibration completed.",
      "success",
      1500
    );
    calibrationState.localBusy = false;
    updateCalibrationButtons();
    await fetchCalibrationStatus();
  } catch (error) {
    els.calibrationCountdown.textContent = "Idle";
    setCalibrationStatusWithLock(`Calibration failed: ${error.message}`, "error", 8000);
  } finally {
    calibrationState.localBusy = false;
    updateCalibrationButtons();
  }
}

async function applySavedCalibration() {
  if (calibrationState.localBusy) {
    return;
  }

  calibrationState.localBusy = true;
  updateCalibrationButtons();
  setCalibrationStatusWithLock("Applying saved calibration profile...", "info", 3000);

  try {
    const res = await fetch(CALIBRATION_APPLY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const detail = await readErrorMessage(res, `HTTP ${res.status}`);
      throw new Error(detail);
    }

    const payload = await res.json();
    setCalibrationStatusWithLock(
      payload.message ?? "Saved calibration applied.",
      "success",
      1500
    );
    calibrationState.localBusy = false;
    updateCalibrationButtons();
    await fetchCalibrationStatus();
  } catch (error) {
    setCalibrationStatusWithLock(`Apply failed: ${error.message}`, "error", 8000);
  } finally {
    calibrationState.localBusy = false;
    updateCalibrationButtons();
  }
}

if (els.historyShowMore) {
  els.historyShowMore.addEventListener("click", () => {
    historyState.limit = Math.min(HISTORY_LIMIT_MAX, historyState.limit + HISTORY_PAGE_SIZE);
    fetchAllImu();
  });
}

if (els.historyReset) {
  els.historyReset.addEventListener("click", () => {
    historyState.limit = HISTORY_PAGE_SIZE;
    historyState.lastSignature = "";
    fetchAllImu();
  });
}

if (els.calibrationStart) {
  els.calibrationStart.addEventListener("click", () => {
    startCalibrationFlow();
  });
}

if (els.calibrationApply) {
  els.calibrationApply.addEventListener("click", () => {
    applySavedCalibration();
  });
}

drawThroughputChart();
updateHistoryMeta();
updateHistoryControls();
updateCalibrationButtons();
fetchLatestImu();
fetchAllImu();
fetchThroughput();
fetchHitSummary();
fetchCalibrationStatus();
setInterval(fetchLatestImu, LATEST_POLL_MS);
setInterval(fetchAllImu, HISTORY_POLL_MS);
setInterval(fetchThroughput, THROUGHPUT_POLL_MS);
setInterval(fetchHitSummary, HIT_SUMMARY_POLL_MS);
setInterval(fetchCalibrationStatus, CALIBRATION_STATUS_POLL_MS);
