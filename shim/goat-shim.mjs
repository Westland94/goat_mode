// Port P4 (Task 185): window.goatShim(path, opts) — app.js's api() routes /api/* here instead of fetch when this
// is registered (app.js goatFetch). It boots web/worker/goat-worker.mjs and speaks the PORT-PLAN §5 message
// shape: {id, route, method, body, progress, today} -> {id, status, json, progress?}.
//  - D9: one call in flight at a time (calls queue), and nothing is sent before the worker has booted.
//  - D11: today = the JS local calendar date (YYYY-MM-DD), the same day the Mac server's date.today() gives.
//  - D7: progress is an in-memory dict, sent with every call and replaced by any progress a call returns.
//    Task 186 (P5): it lives in localStorage["goat-progress"] — read at shim load (defensively: missing,
//    corrupt or non-object starts from {}), written through on every save. window.goatProgress, when set
//    before load (probes), still wins. Two tabs are not reconciled (PORT-PLAN D8 storage-event guard: a follow-up).
//  - D3: a 2.0 s wall clock per call (engine.py:15 TIMEOUT_S), started when the call is handed to a booted
//    worker. On expiry: worker.terminate(), a fresh worker boots, and the call resolves with
//    engine.py's _TIMEOUT_RESULT (engine.py:145-146). The next call goes to the new worker.
const TIMEOUT_MS = 2000;
const TIMEOUT_RESULT = { steps: [], stdout: "", timeout: true, error: {
  type: "Timeout", message: "Stopped after 2 seconds — probably a loop that never ends.", line: null } };
const WORKER_URL = new URL("../worker/goat-worker.mjs", import.meta.url);
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

let worker = null, booted = null, nextId = 0, bootId = null, bootDone = false, bootResolve = null;
const waiting = new Map();
const stats = { boots: 0, restarts: 0, timeouts: 0, calls: 0, lastBoot: null };
function startWorker() {
  worker = new Worker(WORKER_URL, { type: "module" });
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
  const id = ++nextId, t0 = performance.now();
  bootId = id; bootDone = false;
  booted = new Promise((res) => { bootResolve = res; waiting.set(id, (d) => { stats.boots += 1; bootDone = true; stats.lastBoot = { ...d.json, wallMs: Math.round(performance.now() - t0) }; res(d); }); });
  worker.postMessage({ id, route: "__boot" });
}
startWorker();

const STORE_KEY = "goat-progress";
function loadStored() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw == null) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};   // a non-object is overwritten on first save
  } catch { return {}; }                                                // corrupt JSON / storage blocked: still boot
}
function saveStored(p) { try { window.localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* quota / blocked: keep the in-memory copy */ } }
let progress = (window.goatProgress && typeof window.goatProgress === "object") ? window.goatProgress : loadStored();
// Task 188 (Port P7, PORT-PLAN D10): the port's GOAT_TODAY. A pinned date wins, in this order: window.goatToday
// (set before load by a probe), the ?today=YYYY-MM-DD URL param, then localStorage["goat-today"]. Anything that
// isn't a valid YYYY-MM-DD is ignored; with no pin, each call uses the local calendar date (D11).
const validDay = (t) => typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)) ? t : null;
const pinnedToday = () => {
  let stored = null; try { stored = window.localStorage.getItem("goat-today"); } catch { /* storage blocked */ }
  return validDay(window.goatToday) || validDay(new URLSearchParams(location.search).get("today")) || validDay(stored);
};
let today = pinnedToday();
let chain = Promise.resolve();

async function call(route, method, body) {
  await booted;
  const id = ++nextId;
  const msg = { id, route, method, body, progress, today: today || localToday() };
  const log = Array.isArray(window.goatShimLog) ? { route, method, body, progressBefore: JSON.parse(JSON.stringify(progress)), today: msg.today, t0: performance.now() } : null;  // probe hook
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {     // D3: the shim owns the clock
      waiting.delete(id); stats.timeouts += 1; stats.restarts += 1;
      worker.terminate(); startWorker();
      // Task 189: ask the fresh worker for this route's own timed-out shape (routes.py __timeout), the way the
      // server embeds a timed-out trace in evaluate/checks/... — not the bare trace object for every route.
      try {
        await booted;
        const tid = ++nextId;
        const d = await new Promise((res) => { waiting.set(tid, res); worker.postMessage({ id: tid, route: "__timeout", method: "POST", body: { route, method, body }, progress, today: msg.today }); });
        resolve({ ...d, progress: undefined, timedOut: true });   // a timed-out call never changes progress
      } catch {
        resolve({ status: 200, json: JSON.parse(JSON.stringify(TIMEOUT_RESULT)), timedOut: true });
      }
    }, TIMEOUT_MS);
    waiting.set(id, (d) => { clearTimeout(timer); if (log) window.goatShimLog.push({ ...log, ms: Math.round(performance.now() - log.t0), status: d.status, json: JSON.parse(JSON.stringify(d.json)), progress: d.progress ? JSON.parse(JSON.stringify(d.progress)) : null }); resolve(d); });  /* the log keeps copies: app.js mutates what it gets (e.g. introSeen) */
    worker.postMessage(msg);
  });
}

window.goatShim = (path, opts = {}) => {
  const url = new URL(path, location.href);
  const route = url.pathname.slice(url.pathname.indexOf("/api/"));
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  stats.calls += 1;
  const p = chain.then(() => call(route, method, body));
  chain = p.catch(() => {});
  return p.then((d) => {
    if (d.progress) { progress = d.progress; saveStored(progress); }
    return { ok: d.status >= 200 && d.status < 300, status: d.status, json: async () => d.json };
  });
};
/* Scratch S7: Stop. Terminate the worker NOW (whatever it is running) and boot a fresh one. Every call still waiting
   on the old worker resolves at once as {status: 499, json: {error: "stopped"}, stopped: true} (its own 2 s timer
   is cleared by its waiter), so the D9 queue never wedges; calls after this go to the new worker. A Stop during the
   very first boot hands the old boot promise to the new boot, so anything awaiting it continues on the new worker. */
function restart() {
  const oldBootId = bootId, oldBootDone = bootDone, oldResolve = bootResolve;
  for (const [id, w] of [...waiting]) {
    if (id === oldBootId) { waiting.delete(id); continue; }
    waiting.delete(id); w({ id, status: 499, json: { error: "stopped" }, stopped: true });
  }
  worker.terminate(); stats.restarts += 1; stats.stops = (stats.stops || 0) + 1;
  startWorker();
  if (!oldBootDone) booted.then(oldResolve);
  return booted;
}
// probe/test hooks (read-only views + the P5 seam)
window.goatShimInfo = { stats, get progress() { return progress; }, setProgress(p) { progress = p; saveStored(p); }, setToday(t) { today = validDay(t); }, get today() { return today || localToday(); }, get booted() { return booted; }, restart };
