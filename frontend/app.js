import { initPaddle3D, updatePaddleIMU } from "./paddle-3d.js";

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const els = {
  status:          document.querySelector("#status"),
  sampleTime:      document.querySelector("#sample-time"),
  dataRate:        document.querySelector("#data-rate"),
  dataRateAvg:     document.querySelector("#data-rate-avg"),
  historyCount:    document.querySelector("#history-count"),
  historyBody:     document.querySelector("#history-body"),
  accelX:          document.querySelector("#accel-x"),
  accelY:          document.querySelector("#accel-y"),
  accelZ:          document.querySelector("#accel-z"),
  gyroRoll:        document.querySelector("#gyro-roll"),
  gyroPitch:       document.querySelector("#gyro-pitch"),
  gyroYaw:         document.querySelector("#gyro-yaw"),
  throughputChart: document.querySelector("#throughput-chart"),
  // Session
  sessionBtn:      document.querySelector("#session-btn"),
  sessionStatus:   document.querySelector("#session-status"),
  // Replay
  replayBar:       document.querySelector("#replay-bar"),
  replayScrubber:  document.querySelector("#replay-scrubber"),
  replayTimestamp: document.querySelector("#replay-timestamp"),
  replayPlayBtn:   document.querySelector("#replay-play-btn"),
  replayCounter:   document.querySelector("#replay-counter"),
  replaySpeed:     document.querySelector("#replay-speed"),
};

// ─── API ──────────────────────────────────────────────────────────────────────
const API = {
  latest:     "/api/imu/latest",
  all:        "/api/imu/all",
  session:    "/api/imu/session",
  throughput: "/api/imu/throughput?window_seconds=60",
};

const LATEST_POLL_MS     = 250;
const HISTORY_POLL_MS    = 3000;
const THROUGHPUT_POLL_MS = 1000;

// ─── Session state machine ────────────────────────────────────────────────────
//  IDLE → [Start] → CONFIRMING → [first live point] → RECORDING
//  RECORDING → [Stop] → LOADING → [fetch done] → REPLAY
//  REPLAY → [Start] → IDLE → CONFIRMING → ...
const S = { IDLE:"idle", CONFIRMING:"confirming", RECORDING:"recording",
            LOADING:"loading", REPLAY:"replay" };

const session = {
  state:       S.IDLE,
  startIso:    null,   // ISO of first confirmed data point
  startNs:     null,   // ns int of first confirmed data point
  endIso:      null,   // ISO wall-clock when Stop was clicked
  lastSeenNs:  null,   // ns of most recent live point (used as end boundary)
  entries:     [],     // full session data oldest-first (populated after stop)
};

// ─── Replay state ─────────────────────────────────────────────────────────────
const replay = {
  index:      0,
  playing:    false,
  timerId:    null,
  speedMs:    25,      // default ~40fps, matches 40pts/s data rate
};

const throughputState = { points: [] };

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = v => Number(v).toFixed(4);

// "2026-02-28T15:12:01.025000+00:00" → "15:12:01.025000"
function fmtTs(iso) {
  if (!iso) return "—";
  const m = iso.match(/T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  return m ? m[1] : iso;
}

function fmtWallTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString() : "—";
}

// ─── Session button ───────────────────────────────────────────────────────────

els.sessionBtn?.addEventListener("click", () => {
  if (session.state === S.IDLE || session.state === S.REPLAY) startConfirming();
  else if (session.state === S.CONFIRMING || session.state === S.RECORDING) stopSession();
});

function startConfirming() {
  Object.assign(session, { state: S.CONFIRMING, startIso: null, startNs: null,
                            endIso: null, lastSeenNs: null, entries: [] });
  stopPlayback();
  hideReplayBar();
  els.sessionBtn.textContent    = "Stop Session";
  els.sessionBtn.classList.add("active");
  els.sessionBtn.disabled       = false;
  els.sessionStatus.textContent = "Waiting for first data point…";
  els.sessionStatus.className   = "session-status-text confirming";
}

function confirmRecording(iso, ns) {
  session.state    = S.RECORDING;
  session.startIso = iso;
  session.startNs  = ns ?? null;
  els.sessionStatus.textContent = `● Recording  ${fmtWallTime(iso)}`;
  els.sessionStatus.className   = "session-status-text recording";
}

function stopSession() {
  session.state  = S.LOADING;
  session.endIso = new Date().toISOString();
  els.sessionBtn.textContent    = "Start Session";
  els.sessionBtn.classList.remove("active");
  els.sessionBtn.disabled       = true;
  els.sessionStatus.textContent = "Loading session data…";
  els.sessionStatus.className   = "session-status-text loading";
  loadAndEnterReplay();
}

async function loadAndEnterReplay() {
  if (!session.startIso) {
    session.state = S.IDLE;
    els.sessionBtn.disabled = false;
    els.sessionStatus.textContent = "No data recorded.";
    els.sessionStatus.className   = "session-status-text";
    return;
  }

  // Use ns timestamps when available so WHERE clause matches InfluxDB exactly
  const startParam = session.startNs   ? String(session.startNs)  : session.startIso;
  const endParam   = session.lastSeenNs ? String(session.lastSeenNs) : session.endIso;
  const url = `${API.session}?start=${encodeURIComponent(startParam)}&end=${encodeURIComponent(endParam)}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    session.entries = (await res.json()).entries ?? [];
  } catch { session.entries = []; }

  session.state           = S.REPLAY;
  els.sessionBtn.disabled = false;

  if (!session.entries.length) {
    els.sessionStatus.textContent = "Session ended — 0 points found.";
    els.sessionStatus.className   = "session-status-text";
    return;
  }

  const n = session.entries.length;
  els.sessionStatus.textContent =
    `${fmtWallTime(session.startIso)} → ${fmtWallTime(session.endIso)}  ·  ${n.toLocaleString()} pts`;
  els.sessionStatus.className = "session-status-text done";

  // Table and chart stay live — they already show current data.
  // Just set up replay bar and auto-play.
  replay.index = 0;
  showReplayBar();
  startPlayback();   // auto-play as requested
}

// ─── Replay bar ───────────────────────────────────────────────────────────────

function showReplayBar() {
  els.replayBar.style.display   = "flex";
  els.replayScrubber.min        = 0;
  els.replayScrubber.max        = session.entries.length - 1;
  els.replayScrubber.value      = 0;
  els.replayPlayBtn.textContent = "⏸";  // shows pause because auto-play starts
}

function hideReplayBar() {
  els.replayBar.style.display = "none";
  stopPlayback();
}

function scrubToFrame(index) {
  if (!session.entries.length) return;
  index = Math.max(0, Math.min(index, session.entries.length - 1));
  replay.index = index;

  const e = session.entries[index];
  els.replayScrubber.value        = index;
  els.replayTimestamp.textContent = fmtTs(e.timestamp);
  els.replayCounter.textContent   =
    `${(index + 1).toLocaleString()} / ${session.entries.length.toLocaleString()}`;

  // Drive sensor readouts with this frame's data
  els.accelX.textContent     = fmt(e.x);
  els.accelY.textContent     = fmt(e.y);
  els.accelZ.textContent     = fmt(e.z);
  els.gyroRoll.textContent   = fmt(e.roll);
  els.gyroPitch.textContent  = fmt(e.pitch);
  els.gyroYaw.textContent    = fmt(e.yaw);
  els.sampleTime.textContent = fmtTs(e.timestamp);

  // Drive 3D paddle
  updatePaddleIMU({ roll: e.roll, pitch: e.pitch, yaw: e.yaw,
                    x: e.x, y: e.y, z: e.z });

  // // Highlight matching table row
  // const rows = els.historyBody.querySelectorAll("tr[data-ts]");
  // rows.forEach(r => r.classList.remove("replay-active"));
  // const match = els.historyBody.querySelector(`tr[data-ts="${CSS.escape(e.timestamp ?? '')}"]`);
  // if (match) {
  //   match.classList.add("replay-active");
  //   match.scrollIntoView({ block: "nearest", behavior: "smooth" });
  // }
}

function startPlayback() {
  if (replay.playing) return;
  replay.playing = true;
  els.replayPlayBtn.textContent = "⏸";
  replay.timerId = setInterval(() => {
    if (replay.index >= session.entries.length - 1) { stopPlayback(); return; }
    scrubToFrame(replay.index + 1);
  }, replay.speedMs);
}

function stopPlayback() {
  replay.playing = false;
  if (replay.timerId) { clearInterval(replay.timerId); replay.timerId = null; }
  if (els.replayPlayBtn) els.replayPlayBtn.textContent = "▶";
}

els.replayPlayBtn?.addEventListener("click", () => {
  if (replay.playing) { stopPlayback(); return; }
  if (replay.index >= session.entries.length - 1) scrubToFrame(0);
  startPlayback();
});

els.replayScrubber?.addEventListener("input", e => {
  stopPlayback();
  scrubToFrame(Number(e.target.value));
});

els.replaySpeed?.addEventListener("change", e => {
  // Dropdown values: "fast"=10ms, "normal"=25ms, "slow"=100ms, "step"=0 (manual)
  const map = { fast: 10, normal: 25, slow: 100 };
  replay.speedMs = map[e.target.value] ?? 25;
  if (replay.playing) { stopPlayback(); startPlayback(); }
});

// ─── Throughput chart ─────────────────────────────────────────────────────────

function drawThroughputChart(points, labelL, labelR) {
  if (!els.throughputChart) return;
  const ctx = els.throughputChart.getContext("2d");
  const W = els.throughputChart.width, H = els.throughputChart.height;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const L = 42, R = W - 10, T = 12, B = H - 26;
  const CW = R - L, CH = B - T;

  ctx.strokeStyle = "#d8e2ef"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, T); ctx.lineTo(L, B); ctx.lineTo(R, B); ctx.stroke();

  const max = Math.max(10, ...points.map(p => p.count));
  ctx.font = "11px IBM Plex Sans, Segoe UI, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = T + (i / 4) * CH;
    ctx.strokeStyle = "#edf2f8";
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    ctx.fillStyle = "#4c5f79"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(String(Math.round(max * (1 - i / 4))), L - 6, y);
  }

  if (!points.length) {
    ctx.fillStyle = "#6d7f98"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("No data", W / 2, H / 2); return;
  }

  ctx.strokeStyle = "#007f8c"; ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((pt, i) => {
    const x = points.length === 1 ? L + CW / 2 : L + (i / (points.length - 1)) * CW;
    const y = B - (pt.count / max) * CH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.fillStyle = "#007f8c";
  ctx.beginPath(); ctx.arc(R, B - (last.count / max) * CH, 3.5, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = "#4c5f79"; ctx.textBaseline = "top";
  ctx.textAlign = "left";  ctx.fillText(labelL ?? "-60s", L, B + 6);
  ctx.textAlign = "right"; ctx.fillText(labelR ?? "now",  R, B + 6);
}

// ─── Live fetchers ────────────────────────────────────────────────────────────

async function fetchLatestImu() {
  // During replay, freeze sensor readouts — the scrubber owns them
  if (session.state === S.REPLAY) return;

  try {
    const res = await fetch(API.latest, { cache: "no-store" });
    if (!res.ok) {
      let d = ""; try { const e = await res.json(); d = e?.detail ? ` - ${e.detail}` : ""; } catch {}
      throw new Error(`HTTP ${res.status}${d}`);
    }
    const payload = await res.json();
    const { acceleration, gyroscope, timestamp } = payload;

    els.accelX.textContent    = fmt(acceleration.x);
    els.accelY.textContent    = fmt(acceleration.y);
    els.accelZ.textContent    = fmt(acceleration.z);
    els.gyroRoll.textContent  = fmt(gyroscope.roll);
    els.gyroPitch.textContent = fmt(gyroscope.pitch);
    els.gyroYaw.textContent   = fmt(gyroscope.yaw);
    els.status.textContent    = "Connected";
    els.status.classList.add("connected");
    els.sampleTime.textContent = fmtTs(timestamp);

    // Confirm session on first live point after clicking Start
    if (session.state === S.CONFIRMING && timestamp) {
      confirmRecording(timestamp, payload.timestamp_ns ?? null);
    }
    // Track end boundary for session query
    if (session.state === S.RECORDING && payload.timestamp_ns) {
      session.lastSeenNs = payload.timestamp_ns;
    }

    updatePaddleIMU({ roll: gyroscope.roll, pitch: gyroscope.pitch, yaw: gyroscope.yaw,
                      x: acceleration.x,   y: acceleration.y,       z: acceleration.z });
  } catch (err) {
    els.status.textContent = `Waiting for IMU data (${err.message})`;
    els.status.classList.remove("connected");
  }
}

async function fetchThroughput() {
  if (session.state === S.LOADING) return;
  try {
    const res = await fetch(API.throughput, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = await res.json();
    throughputState.points      = Array.isArray(p.points) ? p.points : [];
    els.dataRate.textContent    = String(Number(p.latest_complete_dps ?? 0));
    els.dataRateAvg.textContent = Number(p.average_dps ?? 0).toFixed(2);
    drawThroughputChart(throughputState.points);
  } catch {}
}

async function fetchAllImu() {
  if (session.state === S.LOADING) return;
  try {
    const res = await fetch(API.all, { cache: "no-store" });
    if (!res.ok) return;
    const p = await res.json();
    els.historyCount.textContent = String(p.count ?? 0);
    renderHistory(p.entries ?? []);
  } catch {}
}

function renderHistory(entries) {
  if (!entries.length) {
    els.historyBody.innerHTML = '<tr><td colspan="7">No data yet.</td></tr>';
    return;
  }
  const inReplay = session.state === S.REPLAY;
  els.historyBody.innerHTML = entries.map(row => `
    <tr data-ts="${row.timestamp ?? ''}" style="cursor:${inReplay ? 'pointer' : 'default'}">
      <td class="ts-cell" title="${row.timestamp ?? ''}">${fmtTs(row.timestamp)}</td>
      <td>${fmt(row.x)}</td>
      <td>${fmt(row.y)}</td>
      <td>${fmt(row.z)}</td>
      <td>${fmt(row.roll)}</td>
      <td>${fmt(row.pitch)}</td>
      <td>${fmt(row.yaw)}</td>
    </tr>`).join("");

  // Clicking a row during replay jumps the scrubber to that frame
  if (inReplay) {
    els.historyBody.querySelectorAll("tr[data-ts]").forEach((tr, i) => {
      tr.addEventListener("click", () => {
        // Find matching frame index in session entries
        const ts = tr.dataset.ts;
        const idx = session.entries.findIndex(e => e.timestamp === ts);
        if (idx >= 0) { stopPlayback(); scrubToFrame(idx); }
      });
    });
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

drawThroughputChart([], "-60s", "now");
fetchLatestImu();
fetchAllImu();
fetchThroughput();
initPaddle3D("#paddle-canvas");

setInterval(fetchLatestImu,  LATEST_POLL_MS);
setInterval(fetchAllImu,     HISTORY_POLL_MS);
setInterval(fetchThroughput, THROUGHPUT_POLL_MS);
