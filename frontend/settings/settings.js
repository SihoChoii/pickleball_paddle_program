const els = {
  calibrationStart: document.querySelector("#calibration-start"),
  calibrationApply: document.querySelector("#calibration-apply"),
  calibrationCountdown: document.querySelector("#calibration-countdown"),
  calibrationStatus: document.querySelector("#calibration-status"),
  calibrationLast: document.querySelector("#calibration-last"),
};

const CALIBRATION_STATUS_API_URL = "/api/calibration/status";
const CALIBRATION_START_API_URL = "/api/calibration/start";
const CALIBRATION_APPLY_API_URL = "/api/calibration/apply";

const CALIBRATION_STATUS_POLL_MS = 2000;
const CALIBRATION_COUNTDOWN_SECONDS = 8;
const CALIBRATION_WINDOW_SECONDS = 8;
const CALIBRATION_FRESH_WINDOW = true;

const calibrationState = {
  localBusy: false,
  statusLockUntilMs: 0,
};

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
    // Ignore non-JSON error bodies.
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
      setCalibrationStatus(`Backend rewrite worker error: ${rewriteWorker.last_error}`, "error");
      return;
    }

    if (lastResult?.message && lastResult?.ok === false) {
      const stillActive = Boolean(activeProfile);
      const suffix = stillActive ? " (previous calibration profile is still active)" : "";
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
      setCalibrationStatus(String(lastResult.message), lastResult?.ok ? "success" : "error");
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
    if (els.calibrationCountdown) {
      els.calibrationCountdown.textContent = "Done";
    }
    setCalibrationStatusWithLock(payload.message ?? "Calibration completed.", "success", 1500);
    calibrationState.localBusy = false;
    updateCalibrationButtons();
    await fetchCalibrationStatus();
  } catch (error) {
    if (els.calibrationCountdown) {
      els.calibrationCountdown.textContent = "Idle";
    }
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
    setCalibrationStatusWithLock(payload.message ?? "Saved calibration applied.", "success", 1500);
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

updateCalibrationButtons();
fetchCalibrationStatus();
setInterval(fetchCalibrationStatus, CALIBRATION_STATUS_POLL_MS);
