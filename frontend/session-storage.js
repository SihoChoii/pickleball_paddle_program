const STORAGE_KEY = "pickleball.savedSessions.v1";
const RESET_WARNING_KEY = `${STORAGE_KEY}.resetWarning`;
const MAX_SAVED_SESSIONS = 500;
const SOURCE = "live-recording";
const SORT_PRESETS = new Set([
  "newest",
  "oldest",
  "longest",
  "shortest",
  "most_points",
  "fewest_points",
]);

function toIsoOrNull(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function toIntOrNull(value) {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function toCountOrNull(value) {
  if (!Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n >= 0 ? n : null;
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;

  const startIso = toIsoOrNull(raw.startIso);
  const endIso = toIsoOrNull(raw.endIso);
  const createdAtIso = toIsoOrNull(raw.createdAtIso);
  const pointCount = toCountOrNull(raw.pointCount);
  const durationMs = toCountOrNull(raw.durationMs);
  const startNs = toIntOrNull(raw.startNs);
  const endNs = toIntOrNull(raw.endNs);

  if (!startIso || !endIso || !createdAtIso) return null;
  if (pointCount === null || durationMs === null) return null;

  const id = typeof raw.id === "string" && raw.id.trim()
    ? raw.id
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    startIso,
    endIso,
    startNs,
    endNs,
    pointCount,
    durationMs,
    createdAtIso,
    source: SOURCE,
  };
}

function markResetWarning(reason) {
  try {
    localStorage.setItem(RESET_WARNING_KEY, JSON.stringify({
      reason,
      at: new Date().toISOString(),
    }));
  } catch {
    // ignore localStorage failures
  }
}

function safeGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore localStorage failures
  }
}

function safeRemoveItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore localStorage failures
  }
}

function writeSessions(sessions) {
  safeSetItem(STORAGE_KEY, JSON.stringify(sessions));
}

function applyCap(sessions) {
  if (sessions.length <= MAX_SAVED_SESSIONS) return { sessions, capped: false };
  const sorted = [...sessions].sort((a, b) => (
    Date.parse(a.createdAtIso) - Date.parse(b.createdAtIso)
  ));
  return {
    sessions: sorted.slice(sorted.length - MAX_SAVED_SESSIONS),
    capped: true,
  };
}

function cleanSessions(rawSessions) {
  const normalized = [];
  let invalidRemoved = 0;
  for (const raw of rawSessions) {
    const session = normalizeSession(raw);
    if (session) normalized.push(session);
    else invalidRemoved += 1;
  }
  const { sessions, capped } = applyCap(normalized);
  return { sessions, invalidRemoved, capped };
}

function readSessions() {
  let parsed;
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    parsed = JSON.parse(raw);
  } catch {
    writeSessions([]);
    markResetWarning("Saved sessions were corrupted and have been reset.");
    return [];
  }

  if (!Array.isArray(parsed)) {
    writeSessions([]);
    markResetWarning("Saved sessions had invalid format and were reset.");
    return [];
  }

  const { sessions: cleaned, invalidRemoved, capped } = cleanSessions(parsed);
  if (invalidRemoved > 0 || capped) {
    writeSessions(cleaned);
  }
  if (invalidRemoved > 0) {
    markResetWarning("Some invalid saved sessions were removed.");
  } else if (capped) {
    markResetWarning("Saved sessions reached the limit; oldest records were trimmed.");
  }

  return cleaned;
}

function matchesSessionIdentity(existing, next) {
  const hasExistingNs = Number.isInteger(existing.startNs) && Number.isInteger(existing.endNs);
  const hasNextNs = Number.isInteger(next.startNs) && Number.isInteger(next.endNs);

  if (hasExistingNs && hasNextNs) {
    return existing.startNs === next.startNs && existing.endNs === next.endNs;
  }
  return existing.startIso === next.startIso && existing.endIso === next.endIso;
}

export function listSavedSessions() {
  return readSessions();
}

export function getSavedSessionById(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  const sessions = readSessions();
  return sessions.find((item) => item.id === sessionId) ?? null;
}

export function buildSessionBounds(session) {
  if (!session || typeof session !== "object") return null;

  const hasNsBounds = Number.isInteger(session.startNs) && Number.isInteger(session.endNs);
  if (hasNsBounds) {
    return {
      startParam: String(session.startNs),
      endParam: String(session.endNs),
    };
  }

  const startIso = toIsoOrNull(session.startIso);
  const endIso = toIsoOrNull(session.endIso);
  if (!startIso || !endIso) return null;

  return {
    startParam: startIso,
    endParam: endIso,
  };
}

export function upsertSavedSession(session) {
  const normalized = normalizeSession(session);
  if (!normalized) return;

  const sessions = readSessions();
  const index = sessions.findIndex(item => matchesSessionIdentity(item, normalized));

  if (index >= 0) {
    const existing = sessions[index];
    sessions[index] = {
      ...normalized,
      id: existing.id || normalized.id,
      createdAtIso: existing.createdAtIso || normalized.createdAtIso,
      source: SOURCE,
    };
  } else {
    sessions.push(normalized);
  }

  const { sessions: cappedSessions } = applyCap(sessions);
  writeSessions(cappedSessions);
}

export function sortSavedSessions(sessions, preset) {
  const safe = Array.isArray(sessions) ? [...sessions] : [];
  const sortPreset = SORT_PRESETS.has(preset) ? preset : "newest";

  const byStart = (a, b) => Date.parse(a.startIso) - Date.parse(b.startIso);
  const byDuration = (a, b) => a.durationMs - b.durationMs;
  const byCount = (a, b) => a.pointCount - b.pointCount;

  switch (sortPreset) {
    case "oldest":
      return safe.sort((a, b) => byStart(a, b) || byDuration(a, b));
    case "longest":
      return safe.sort((a, b) => byDuration(b, a) || byStart(b, a));
    case "shortest":
      return safe.sort((a, b) => byDuration(a, b) || byStart(a, b));
    case "most_points":
      return safe.sort((a, b) => byCount(b, a) || byStart(b, a));
    case "fewest_points":
      return safe.sort((a, b) => byCount(a, b) || byStart(a, b));
    case "newest":
    default:
      return safe.sort((a, b) => byStart(b, a) || byDuration(b, a));
  }
}

export function consumeStorageResetWarning() {
  const raw = safeGetItem(RESET_WARNING_KEY);
  if (!raw) return null;
  safeRemoveItem(RESET_WARNING_KEY);

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.reason === "string") return parsed.reason;
  } catch {
    // ignore parse failures
  }
  return "Saved session storage was reset.";
}
