import {
  consumeStorageResetWarning,
  listSavedSessions,
  sortSavedSessions,
} from "./session-storage.js";

const els = {
  count: document.querySelector("#sessions-count"),
  sort: document.querySelector("#sessions-sort"),
  body: document.querySelector("#sessions-body"),
  empty: document.querySelector("#sessions-empty"),
  tableWrap: document.querySelector("#sessions-table-wrap"),
  warning: document.querySelector("#sessions-warning"),
};

const state = {
  sessions: [],
  sortPreset: "newest",
};

function formatLocalDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function pad2(num) {
  return String(num).padStart(2, "0");
}

function formatDuration(durationMs) {
  const ms = Math.max(0, Number(durationMs) || 0);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

function buildReviewHref(session) {
  const params = new URLSearchParams();
  if (session?.id) params.set("sessionId", session.id);

  if (Number.isInteger(session?.startNs) && Number.isInteger(session?.endNs)) {
    params.set("start", String(session.startNs));
    params.set("end", String(session.endNs));
  } else {
    if (session?.startIso) params.set("start", session.startIso);
    if (session?.endIso) params.set("end", session.endIso);
  }

  return `/session-review.html?${params.toString()}`;
}

function showWarningIfAny() {
  const warning = consumeStorageResetWarning();
  if (!warning || !els.warning) return;
  els.warning.textContent = warning;
  els.warning.hidden = false;
}

function renderRows() {
  const sorted = sortSavedSessions(state.sessions, state.sortPreset);
  const count = sorted.length;
  if (els.count) els.count.textContent = String(count);

  if (!count) {
    if (els.empty) els.empty.hidden = false;
    if (els.tableWrap) els.tableWrap.hidden = true;
    return;
  }

  if (els.empty) els.empty.hidden = true;
  if (els.tableWrap) els.tableWrap.hidden = false;
  if (!els.body) return;

  els.body.innerHTML = sorted.map((session) => {
    return `
      <tr>
        <td title="${session.startIso}">${formatLocalDateTime(session.startIso)}</td>
        <td title="${session.endIso}">${formatLocalDateTime(session.endIso)}</td>
        <td>${formatDuration(session.durationMs)}</td>
        <td>${session.pointCount.toLocaleString()}</td>
        <td title="${session.createdAtIso}">${formatLocalDateTime(session.createdAtIso)}</td>
        <td><a class="sessions-review-link" href="${buildReviewHref(session)}">Open</a></td>
      </tr>
    `;
  }).join("");
}

function init() {
  state.sessions = listSavedSessions();
  if (els.sort) {
    state.sortPreset = els.sort.value || "newest";
    els.sort.addEventListener("change", () => {
      state.sortPreset = els.sort.value || "newest";
      renderRows();
    });
  }
  showWarningIfAny();
  renderRows();
}

init();
