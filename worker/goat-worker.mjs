// Port P3 (Task 184): the GOAT Mode back end as a module Web Worker. Pages build: loads Pyodide from CDN, pinned to the vendored build 314.0.8,
// writes app's Python modules (web/py/, byte copies) and the 179 problems (web/problems/ + index.json)
// into Pyodide's FS at /app, then answers {id, route, method, body, progress, today} with
// {id, status, json, progress?} — the PORT-PLAN §5 message shape.
import { loadPyodide } from "https://cdn.jsdelivr.net/npm/pyodide@314.0.8/pyodide.mjs";
const base = new URL("../", import.meta.url);
const boot = (async () => {
  const t0 = performance.now();
  const py = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/npm/pyodide@314.0.8/" });
  const tLoad = performance.now() - t0;
  py.FS.mkdirTree("/app/problems");
  const text = async (p) => { const r = await fetch(new URL(p, base)); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.text(); };
  for (const m of ["engine.py", "tracer.py", "stage_emitter.py", "stage_check.py"]) py.FS.writeFile(`/app/${m}`, await text(`py/${m}`));
  const files = JSON.parse(await text("problems/index.json"));
  const bodies = await Promise.all(files.map((f) => text(`problems/${f}`)));
  files.forEach((f, i) => py.FS.writeFile(`/app/problems/${f}`, bodies[i]));
  py.FS.writeFile("/app/routes.py", await text("worker/routes.py"));
  py.runPython("import sys; sys.path.insert(0, '/app'); import routes");
  const handle = py.globals.get("routes").handle;  // `import routes` ran in the global namespace
  return { py, handle, info: { pyodide: py.version, python: py.runPython("import sys; sys.version.split()[0]"), loadMs: Math.round(tLoad), bootMs: Math.round(performance.now() - t0), problems: files.length } };
})();
// /api/intro_seen is pure JS (PORT-PLAN §5, route 10): server.py:220-227 on the passed-in progress
function introSeen(body, progress) {
  const prog = progress && typeof progress === "object" ? progress : { attempts: [], items: {} };
  const seen = (prog.intro_seen ||= []);
  if (!seen.includes(body.problem_id)) seen.push(body.problem_id);
  return { status: 200, json: { intro_seen: seen }, progress: prog };
}
self.onmessage = async (e) => {
  const { id, route, method = "GET", body = null, progress = null, today } = e.data;
  try {
    const b = await boot;
    if (route === "__boot") return self.postMessage({ id, status: 200, json: b.info });
    if (route === "/api/intro_seen") return self.postMessage({ id, ...introSeen(body || {}, progress) });
    const out = JSON.parse(b.handle(JSON.stringify({ route, method, body, progress, today })));
    self.postMessage({ id, ...out });
  } catch (err) {
    self.postMessage({ id, status: 500, json: { error: `WorkerError: ${err && err.message || err}` } });
  }
};
