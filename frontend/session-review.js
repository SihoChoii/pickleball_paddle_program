import { initPaddle3D, updatePaddleIMU } from "./paddle-3d.js?v=5";
import { buildSessionBounds, getSavedSessionById } from "./session-storage.js";

const API_SESSION = "/api/imu/session";
const ACCEL_EMA_ALPHA = 0.22;
const HIT_SUSTAIN_MAX = 5;

const VIEW = {
  LOADING: "loading",
  READY: "ready",
  EMPTY: "empty",
  ERROR: "error",
  SESSION_NOT_FOUND: "session-not-found",
};

const els = {
  title: document.querySelector("#review-title"),
  subtitle: document.querySelector("#review-subtitle"),
  state: document.querySelector("#review-state"),
  retryBtn: document.querySelector("#review-retry-btn"),

  metrics: document.querySelector("#review-metrics"),
  replaySection: document.querySelector("#review-replay"),
  chartSection: document.querySelector(".session-review-chart"),
  tableSection: document.querySelector("#review-table-shell"),

  accelX: document.querySelector("#review-accel-x"),
  accelY: document.querySelector("#review-accel-y"),
  accelZ: document.querySelector("#review-accel-z"),
  gyroRoll: document.querySelector("#review-gyro-roll"),
  gyroPitch: document.querySelector("#review-gyro-pitch"),
  gyroYaw: document.querySelector("#review-gyro-yaw"),

  frameStamp: document.querySelector("#review-frame-stamp"),
  accelCurrent: document.querySelector("#review-accel-current"),

  playBtn: document.querySelector("#review-play-btn"),
  scrubber: document.querySelector("#review-scrubber"),
  speed: document.querySelector("#review-speed"),
  timestamp: document.querySelector("#review-timestamp"),
  counter: document.querySelector("#review-counter"),

  hitOverlay: document.querySelector("#review-hit-overlay"),
  accelChart: document.querySelector("#review-accel-chart"),

  tableToggle: document.querySelector("#review-table-toggle"),
  tableRegion: document.querySelector("#review-table-region"),
  tableBody: document.querySelector("#review-table-body"),
};

const state = {
  request: null,
  sessionMeta: null,
  entries: [],
  accelSeries: [],
  tableRendered: false,
};

const replay = {
  index: 0,
  playing: false,
  timerId: null,
  speedMs: 25,
};

let hitSustainFrames = 0;

const fmt = (value) => Number(value ?? 0).toFixed(4);

function fmtTs(iso) {
  if (!iso) return "-";
  const match = String(iso).match(/T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  return match ? match[1] : String(iso);
}

function formatLocalDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatClockDuration(durationMs) {
  const safeMs = Math.max(0, Number(durationMs) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatLongDuration(durationMs) {
  const safeMs = Math.max(0, Number(durationMs) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseUrlRequest() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId")?.trim() || "";
  const queryStart = params.get("start")?.trim() || "";
  const queryEnd = params.get("end")?.trim() || "";

  if (sessionId) {
    const sessionMeta = getSavedSessionById(sessionId);
    if (sessionMeta) {
      const bounds = buildSessionBounds(sessionMeta);
      if (bounds) return { kind: "ok", sessionId, sessionMeta, bounds };
    }

    if (!queryStart) {
      return { kind: "session-not-found" };
    }
  }

  if (!queryStart) {
    return {
      kind: "error",
      message: "Missing session identifiers. Open this page from Saved Sessions or include start and end URL params.",
    };
  }

  return {
    kind: "ok",
    sessionId,
    sessionMeta: null,
    bounds: {
      startParam: queryStart,
      endParam: queryEnd,
    },
  };
}

function setViewState(view, message = "") {
  if (!els.state) return;

  els.state.hidden = view === VIEW.READY;
  els.state.dataset.state = view;
  els.retryBtn.hidden = view !== VIEW.ERROR;

  if (view === VIEW.READY) return;

  if (view === VIEW.SESSION_NOT_FOUND) {
    els.state.innerHTML = 'Session was not found. <a href="/sessions.html">Go to Saved Sessions</a>.';
    return;
  }

  els.state.textContent = message;
}

function hideDataSections() {
  stopPlayback();
  if (els.replaySection) els.replaySection.hidden = true;
  if (els.chartSection) els.chartSection.hidden = true;
  if (els.tableSection) els.tableSection.hidden = true;
}

function showDataSections() {
  if (els.replaySection) els.replaySection.hidden = false;
  if (els.chartSection) els.chartSection.hidden = false;
  if (els.tableSection) els.tableSection.hidden = false;
}

function resolveRangeInfo(entries, sessionMeta) {
  const first = entries[0]?.timestamp || sessionMeta?.startIso || null;
  const last = entries[entries.length - 1]?.timestamp || sessionMeta?.endIso || null;
  return { first, last };
}

function buildAccelerationSeries(entries) {
  const series = [];
  let prevSmooth = null;
  let prevTms = null;

  entries.forEach((entry, index) => {
    let tMs = Number.NaN;
    if (entry.timestamp) tMs = Date.parse(entry.timestamp);

    if (!Number.isFinite(tMs)) {
      tMs = prevTms === null ? index * 25 : prevTms + 25;
    }
    if (prevTms !== null && tMs <= prevTms) {
      tMs = prevTms + 1;
    }

    const x = Number(entry.x ?? 0);
    const y = Number(entry.y ?? 0);
    const z = Number(entry.z ?? 0);
    const raw = Math.sqrt(x * x + y * y + z * z);
    const smooth = prevSmooth === null
      ? raw
      : prevSmooth + ACCEL_EMA_ALPHA * (raw - prevSmooth);

    series.push({
      tMs,
      raw,
      smooth,
      hit: Number(entry.hit_flag ?? entry.hit ?? 0) === 1,
    });

    prevSmooth = smooth;
    prevTms = tMs;
  });

  return series;
}

function computeDurationMs(series, fallbackDurationMs) {
  if (series.length > 1) {
    const durationMs = series[series.length - 1].tMs - series[0].tMs;
    if (Number.isFinite(durationMs) && durationMs >= 0) return durationMs;
  }

  if (Number.isFinite(fallbackDurationMs) && fallbackDurationMs >= 0) {
    return Math.floor(fallbackDurationMs);
  }

  return 0;
}

function computeMetrics(entries, series, fallbackDurationMs) {
  const pointCount = entries.length;
  if (!pointCount) {
    return {
      pointCount: 0,
      durationMs: Math.max(0, Number(fallbackDurationMs) || 0),
      avgAcceleration: 0,
      peakAcceleration: 0,
      hitCount: 0,
      avgSampleRate: 0,
    };
  }

  let sumAccel = 0;
  let peakAcceleration = 0;
  let hitCount = 0;

  for (const point of series) {
    sumAccel += point.raw;
    if (point.raw > peakAcceleration) peakAcceleration = point.raw;
    if (point.hit) hitCount += 1;
  }

  const durationMs = computeDurationMs(series, fallbackDurationMs);
  const avgSampleRate = durationMs > 0 ? ((pointCount - 1) / (durationMs / 1000)) : 0;

  return {
    pointCount,
    durationMs,
    avgAcceleration: sumAccel / pointCount,
    peakAcceleration,
    hitCount,
    avgSampleRate,
  };
}

function renderHeader(metrics, entries) {
  if (!els.title || !els.subtitle) return;

  els.title.textContent = "Session Review";

  const range = resolveRangeInfo(entries, state.sessionMeta);
  const first = range.first ? formatLocalDateTime(range.first) : "-";
  const last = range.last ? formatLocalDateTime(range.last) : "-";
  const points = Number(metrics.pointCount || 0).toLocaleString();
  els.subtitle.textContent = `${first} -> ${last}  |  ${points} points`;
}

function renderMetrics(metrics) {
  if (!els.metrics) return;

  const cards = [
    {
      label: "Duration",
      value: formatLongDuration(metrics.durationMs),
      meta: formatClockDuration(metrics.durationMs),
      tone: "duration",
    },
    {
      label: "Points",
      value: metrics.pointCount.toLocaleString(),
      meta: "Datapoints captured",
      tone: "points",
    },
    {
      label: "Avg Accel",
      value: `${metrics.avgAcceleration.toFixed(3)} g`,
      meta: "Mean |a|",
      tone: "avg",
    },
    {
      label: "Peak Accel",
      value: `${metrics.peakAcceleration.toFixed(3)} g`,
      meta: "Maximum |a|",
      tone: "peak",
    },
    {
      label: "Hits",
      value: metrics.hitCount.toLocaleString(),
      meta: "Hit flag events",
      tone: "hits",
    },
    {
      label: "Avg Sample Rate",
      value: `${metrics.avgSampleRate.toFixed(2)} pts/s`,
      meta: "Computed from duration",
      tone: "rate",
    },
  ];

  els.metrics.innerHTML = cards.map((card) => {
    return `
      <article class="session-review-metric session-review-metric-${card.tone}">
        <p class="session-review-metric-label">${card.label}</p>
        <p class="session-review-metric-value">${card.value}</p>
        <p class="session-review-metric-meta">${card.meta}</p>
      </article>
    `;
  }).join("");

  els.metrics.hidden = false;
}

function drawAccelerationChart(series) {
  if (!els.accelChart) return;

  const ctx = els.accelChart.getContext("2d");
  const W = els.accelChart.width;
  const H = els.accelChart.height;
  const L = 42;
  const R = W - 10;
  const T = 12;
  const B = H - 26;
  const CW = R - L;
  const CH = B - T;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "#d8e2ef";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, T);
  ctx.lineTo(L, B);
  ctx.lineTo(R, B);
  ctx.stroke();

  if (!series.length) {
    ctx.fillStyle = "#6d7f98";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "12px IBM Plex Sans, Segoe UI, sans-serif";
    ctx.fillText("No acceleration data", W / 2, H / 2);

    ctx.fillStyle = "#4c5f79";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("start", L, B + 6);
    ctx.textAlign = "right";
    ctx.fillText("0s", R, B + 6);

    if (els.accelCurrent) els.accelCurrent.textContent = "Current: - g";
    return;
  }

  const startMs = series[0].tMs;
  const endMs = Math.max(startMs + 1, series[series.length - 1].tMs);
  const spanMs = endMs - startMs;

  const mapX = (ms) => {
    const ratio = Math.max(0, Math.min(1, (ms - startMs) / spanMs));
    return L + ratio * CW;
  };

  let min = series[0].smooth;
  let max = series[0].smooth;
  for (const point of series) {
    if (point.smooth < min) min = point.smooth;
    if (point.smooth > max) max = point.smooth;
  }

  const pad = Math.max(0.06, (max - min) * 0.2);
  const yMin = Math.max(0, min - pad);
  let yMax = max + pad;
  if (yMax - yMin < 0.25) yMax = yMin + 0.25;
  const ySpan = yMax - yMin;

  const mapY = (value) => B - ((value - yMin) / ySpan) * CH;

  ctx.font = "11px IBM Plex Sans, Segoe UI, sans-serif";
  for (let i = 0; i <= 4; i += 1) {
    const y = T + (i / 4) * CH;
    ctx.strokeStyle = "#edf2f8";
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(R, y);
    ctx.stroke();

    ctx.fillStyle = "#4c5f79";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const v = yMax - (i / 4) * ySpan;
    ctx.fillText(v.toFixed(2), L - 6, y);
  }

  ctx.strokeStyle = "#007f8c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((point, idx) => {
    const x = mapX(point.tMs);
    const y = mapY(point.smooth);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#d63031";
  for (const point of series) {
    if (!point.hit) continue;
    ctx.beginPath();
    ctx.arc(mapX(point.tMs), mapY(point.smooth), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const last = series[series.length - 1];
  ctx.fillStyle = "#007f8c";
  ctx.beginPath();
  ctx.arc(mapX(last.tMs), mapY(last.smooth), 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#4c5f79";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("start", L, B + 6);
  ctx.textAlign = "right";
  ctx.fillText(formatLongDuration(spanMs), R, B + 6);

  if (els.accelCurrent) {
    els.accelCurrent.textContent = `Current: ${last.smooth.toFixed(3)} g`;
  }
}

function scrubToFrame(nextIndex) {
  if (!state.entries.length) return;

  const maxIndex = state.entries.length - 1;
  const index = Math.max(0, Math.min(nextIndex, maxIndex));
  replay.index = index;

  const entry = state.entries[index];
  const point = state.accelSeries[index];

  els.scrubber.value = String(index);
  els.timestamp.textContent = fmtTs(entry.timestamp);
  els.counter.textContent = `${(index + 1).toLocaleString()} / ${state.entries.length.toLocaleString()}`;
  els.frameStamp.textContent = `Frame ${index + 1}`;

  els.accelX.textContent = fmt(entry.x);
  els.accelY.textContent = fmt(entry.y);
  els.accelZ.textContent = fmt(entry.z);
  els.gyroRoll.textContent = fmt(entry.roll);
  els.gyroPitch.textContent = fmt(entry.pitch);
  els.gyroYaw.textContent = fmt(entry.yaw);

  if (point && els.accelCurrent) {
    els.accelCurrent.textContent = `Current: ${point.smooth.toFixed(3)} g`;
  }

  updatePaddleIMU({
    roll: entry.roll,
    pitch: entry.pitch,
    yaw: entry.yaw,
    x: entry.x,
    y: entry.y,
    z: entry.z,
    hit_flag: entry.hit_flag ?? entry.hit,
  });

  if (els.hitOverlay) {
    if (Number(entry.hit_flag ?? entry.hit ?? 0) === 1) {
      hitSustainFrames = HIT_SUSTAIN_MAX;
    } else if (hitSustainFrames > 0) {
      hitSustainFrames -= 1;
    }
    els.hitOverlay.style.display = hitSustainFrames > 0 ? "block" : "none";
  }
}

function startPlayback() {
  if (replay.playing || !state.entries.length) return;

  replay.playing = true;
  els.playBtn.textContent = "⏸";
  replay.timerId = setInterval(() => {
    if (replay.index >= state.entries.length - 1) {
      stopPlayback();
      return;
    }
    scrubToFrame(replay.index + 1);
  }, replay.speedMs);
}

function stopPlayback() {
  replay.playing = false;
  if (replay.timerId) {
    clearInterval(replay.timerId);
    replay.timerId = null;
  }
  if (els.playBtn) els.playBtn.textContent = "▶";
}

function resetReplayControls() {
  stopPlayback();
  replay.index = 0;
  replay.speedMs = 25;

  if (els.speed) els.speed.value = "normal";
  if (!state.entries.length) return;

  els.scrubber.min = "0";
  els.scrubber.max = String(state.entries.length - 1);
  els.scrubber.value = "0";
  scrubToFrame(0);
}

function setTableExpanded(expanded) {
  if (!els.tableToggle || !els.tableRegion) return;

  const count = state.entries.length;
  els.tableToggle.setAttribute("aria-expanded", String(expanded));
  els.tableRegion.hidden = !expanded;
  els.tableToggle.textContent = expanded
    ? "Hide Raw Datapoints"
    : `Show Raw Datapoints (${count.toLocaleString()})`;
}

function renderTableRows() {
  if (!els.tableBody) return;

  if (!state.entries.length) {
    els.tableBody.innerHTML = '<tr><td colspan="8">No datapoints available.</td></tr>';
    state.tableRendered = true;
    return;
  }

  els.tableBody.innerHTML = state.entries.map((entry) => {
    return `
      <tr>
        <td class="ts-cell" title="${escapeHtml(entry.timestamp ?? "")}">${escapeHtml(fmtTs(entry.timestamp))}</td>
        <td>${fmt(entry.x)}</td>
        <td>${fmt(entry.y)}</td>
        <td>${fmt(entry.z)}</td>
        <td>${fmt(entry.roll)}</td>
        <td>${fmt(entry.pitch)}</td>
        <td>${fmt(entry.yaw)}</td>
        <td>${Number(entry.hit_flag ?? entry.hit ?? 0)}</td>
      </tr>
    `;
  }).join("");

  state.tableRendered = true;
}

async function fetchSessionEntries(bounds) {
  const params = new URLSearchParams();
  params.set("start", bounds.startParam);
  if (bounds.endParam) params.set("end", bounds.endParam);

  const res = await fetch(`${API_SESSION}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    let detail = "";
    try {
      const payload = await res.json();
      detail = payload?.detail ? ` - ${payload.detail}` : "";
    } catch {
      // no-op
    }
    throw new Error(`HTTP ${res.status}${detail}`);
  }

  const payload = await res.json();
  return Array.isArray(payload.entries) ? payload.entries : [];
}

async function loadReview() {
  hideDataSections();
  if (els.metrics) {
    els.metrics.hidden = true;
    els.metrics.innerHTML = "";
  }

  setViewState(VIEW.LOADING, "Loading session data...");

  const request = parseUrlRequest();
  if (request.kind === "session-not-found") {
    setViewState(VIEW.SESSION_NOT_FOUND);
    return;
  }
  if (request.kind === "error") {
    setViewState(VIEW.ERROR, request.message);
    return;
  }

  state.request = request;
  state.sessionMeta = request.sessionMeta;
  state.entries = [];
  state.accelSeries = [];
  state.tableRendered = false;
  setTableExpanded(false);

  try {
    const entries = await fetchSessionEntries(request.bounds);
    state.entries = entries;
    state.accelSeries = buildAccelerationSeries(entries);

    const fallbackDuration = Number(state.sessionMeta?.durationMs ?? 0);
    const metrics = computeMetrics(entries, state.accelSeries, fallbackDuration);

    renderHeader(metrics, entries);
    renderMetrics(metrics);

    if (!entries.length) {
      drawAccelerationChart([]);
      setViewState(VIEW.EMPTY, "This session has no datapoints in the selected range.");
      return;
    }

    showDataSections();
    drawAccelerationChart(state.accelSeries);
    resetReplayControls();
    setTableExpanded(false);

    setViewState(VIEW.READY);
  } catch (error) {
    setViewState(VIEW.ERROR, `Failed to load session data (${error.message}).`);
  }
}

els.playBtn?.addEventListener("click", () => {
  if (!state.entries.length) return;
  if (replay.playing) {
    stopPlayback();
    return;
  }
  if (replay.index >= state.entries.length - 1) scrubToFrame(0);
  startPlayback();
});

els.scrubber?.addEventListener("input", (event) => {
  stopPlayback();
  scrubToFrame(Number(event.target.value));
});

els.speed?.addEventListener("change", (event) => {
  const speedMap = { fast: 10, normal: 25, slow: 100 };
  replay.speedMs = speedMap[event.target.value] ?? 25;
  if (replay.playing) {
    stopPlayback();
    startPlayback();
  }
});

els.tableToggle?.addEventListener("click", () => {
  const expanded = els.tableToggle.getAttribute("aria-expanded") === "true";
  const nextExpanded = !expanded;

  if (nextExpanded && !state.tableRendered) {
    renderTableRows();
  }

  setTableExpanded(nextExpanded);
});

els.retryBtn?.addEventListener("click", () => {
  loadReview();
});

setTableExpanded(false);
initPaddle3D("#review-paddle-canvas");
loadReview();
