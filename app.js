/* GOAT Mode v0 — one loop, every beat, plain DOM.
 * Beats: Open → Restate → Clarify → Plan → Predict → Execute → Divergence →
 *        Fix → Verdict → Follow-up → Schedule   (cold: Open → Restate → Clarify →
 *        Write → Predict → Execute → Verdict → Schedule)
 * Wording rule: a prediction miss is a "split", never "wrong". A bug is the code's, not Andrew's.
 */
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (sel) => document.querySelector(sel);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// Task 185 (Port P4): the GitHub Pages build registers window.goatShim (web/shim/goat-shim.mjs), which answers
// /api/* from an in-browser Pyodide worker. Without it — the Mac server build — this is plain fetch, as before.
const goatFetch = (path, opts) => (typeof window.goatShim === "function" ? window.goatShim(path, opts) : fetch(path, opts));
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  const r = await goatFetch(path, opts);
  return r.json();
}
function pyRepr(v) {
  if (typeof v === "string") return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
  return String(v);
}
const work = () => $("#work");
// Task 110: DOM replaceChildren()/append() stringify null as the text "null" — every fill path goes
// through fill(), which drops null/false children (the same rule h() already applies to its kids).
function fill(el, ...nodes) { el.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false)); return el; }
function show(...nodes) { fill(work(), ...nodes); window.scrollTo?.(0, 0); }
function append(node) { if (node == null || node === false) return node; work().append(node); node.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); return node; }

// ------------------------------------------------------------------ stage (single entry point)
// Every character update goes through stage(). (Task 06 will grow this into the Rive contract.)
function stage({ speaker = "none", bubble = "", other = "" } = {}) {
  const ids = { vesper: ["#char-vesper", "#bubble-vesper"], claude: ["#char-claude", "#bubble-claude"] };
  for (const who of ["vesper", "claude"]) {
    const [c, b] = ids[who];
    const talking = who === speaker;
    $(c).classList.toggle("talking", talking);
    $(c).classList.toggle("quiet", speaker !== "none" && !talking && !other);
    $(b).textContent = talking ? bubble : (other && who !== speaker ? other : "");
  }
}
// Task 111 beat model: a new beat replaces the screen; the beat just finished collapses into a slim
// stage pill in #trail (Task 115: one pill, named for the current stage), and #dots shows progress. Pure paint.
const PHASES = ["intro", "open", "restate", "clarify", "plan", "predict", "execute", "divergence", "fix", "verdict", "follow-up", "schedule"];
// Task 114: a cold run is its own loop (no intro, no plan, it writes instead) — exactly the beats the cold
// path calls: start → beatOpen → beatRestate → beatClarify → beatWriteCold → predict → execute → verdict → schedule
const COLD_PHASES = ["open", "restate", "clarify", "write", "predict", "execute", "verdict", "schedule"];
// Task 192 (Flow R2a): a teach run of a "flow": "blocks" problem (FLOW-REWORK-R1 §1). predict/execute run twice
// (his draft, then his assembly); the dots show each phase name once.
const FLOW_PHASES = ["dissect", "instinct", "predict", "execute", "optimize", "block", "assemble", "predict", "execute", "reveal", "verdict", "follow-up", "schedule"];
const isFlow = () => !!(R && R.mode === "teach" && R.problem && R.problem.flow === "blocks");
let prevBeat = null;
const seenPhases = new Set();
// Task 115: ONE stage pill names the stage you're IN; its text swaps in place on every beat change
const STAGE_NAMES = {
  intro: "Watching the idea", open: "Reading the job", restate: "Picking the plan", clarify: "Asking questions",
  plan: "Writing the plan", predict: "Predicting", execute: "Watching it run", divergence: "Finding the split",
  fix: "Fixing it", verdict: "The verdict", "follow-up": "One more thing", write: "Writing it cold", schedule: "Scheduling the recheck",
  dissect: "Taking it apart", instinct: "Your first version", optimize: "Making it faster", block: "Building a block",
  assemble: "Putting it together", reveal: "The recommended version",
};
// Task 176 (slice G6, #3): predict/execute name their cycle, so the pill says WHICH run you're on.
const CYCLE_NAMES = {
  predict: { draft: "Predicting the draft", fixed: "Predicting your fix", follow_up: "Predicting on new data", cold: "Predicting your code",
    instinct: "Predicting your draft", block: "Predicting the block", assembled: "Predicting your assembly" },
  execute: { draft: "Watching the draft run", fixed: "Watching your fix run", follow_up: "Watching it run on new data", cold: "Watching your code run",
    instinct: "Watching your draft run", block: "Watching the block run", assembled: "Watching your assembly run" },
};
function showStage(name, label) {
  const trail = $("#trail");
  let pill = trail.querySelector(".trail-chip");
  if (!pill) { pill = h("span", { class: "trail-chip", id: "stage-pill" }); fill(trail, pill); }
  const text = label || STAGE_NAMES[name] || name;
  // #15: compare the LABEL, not the beat — draft → fixed → follow-up are all beat "execute"
  if (pill.textContent === text) { pill.dataset.beat = name; return; }
  pill.dataset.beat = name;
  pill.textContent = text;
  pill.classList.remove("swap"); void pill.offsetWidth; pill.classList.add("swap");  // replay chip-in (paint only)
}
function resetTrail() { prevBeat = null; seenPhases.clear(); fill($("#trail")); renderDots(null); }
function renderDots(current) {
  const dots = $("#dots");
  if (!dots) return;
  if (!current || current === "home") return fill(dots);
  const phases = R && R.mode === "cold" ? COLD_PHASES : isFlow() ? [...new Set(FLOW_PHASES)] : PHASES;
  fill(dots, ...phases.map((p) => h("span", { class: "dot" + (p === current ? " on" : seenPhases.has(p) ? " done" : ""), title: p })));
}
function beat(name, label) {
  document.body.dataset.beat = name;
  $("#beat-label").textContent = name === "home" ? "" : "· " + name;
  if (name === "home") { resetTrail(); return; }
  showStage(name, label);
  if (prevBeat) seenPhases.add(prevBeat);
  prevBeat = name;
  renderDots(name);
}

// ------------------------------------------------------------------ round state
let R = null; // the current round
function newRound(problem, mode, manual) {
  return {
    problem, mode, manual: !!manual, started: Date.now(),
    rec: {
      problem_id: problem.id, mode, manual: !!manual,
      restate_text: "", restate_self_mark: null, restate_pick: null, restate_correct: null,
      clarify_asked: [], clarify_unprompted: [], clarify_prompted: [],
      plan_text: "", predictions: [], first_divergence: null,
      hints_used: 0, fix_passed: false, fix_code: "",
      follow_up: null, minutes: 0,
    },
    workingCode: "",
  };
}

// ------------------------------------------------------------------ timer (cold only; soft)
let timerId = null;
function startTimer(seconds) {
  const el = $("#timer"); el.hidden = false;
  const end = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.round((end - Date.now()) / 1000);
    const a = Math.abs(left), mm = Math.floor(a / 60), ss = String(a % 60).padStart(2, "0");
    el.textContent = left >= 0 ? `${mm}:${ss} left` : `+${mm}:${ss} — no penalty, keep going`;
    el.classList.toggle("over", left < 0);
  };
  tick(); timerId = setInterval(tick, 1000);
}
function stopTimer() { clearInterval(timerId); timerId = null; $("#timer").hidden = true; }

// ------------------------------------------------------------------ shared widgets
// Task 181 (slice I1a, #5 variant B): { compact: true } → a closed <details> whose summary is the one-line
// literal (ellipsized) and whose body is the same full table; no h3 (title is ignored when compact).
function dataCard(data, title = "The data", { compact = false } = {}) {
  const v = data.value;
  const rows = Array.isArray(v) ? v : [];
  const cols = rows.length && Array.isArray(rows[0]) ? rows[0].length : 1;
  const table = rows.length ? h("table", { class: "data" },
    h("tr", {}, h("th", {}, "#"), ...Array.from({ length: cols }, (_, i) => h("th", {}, cols === 1 ? "value" : `field ${i + 1}`))),
    ...rows.map((r, i) => h("tr", {}, h("td", {}, i), ...(Array.isArray(r) ? r : [r]).map((x) => h("td", {}, pyRepr(x)))))
  ) : h("p", { class: "muted" }, "(empty)");
  if (compact) return h("details", { class: "card data-compact", id: "data-card" },
    h("summary", {}, `${data.name} = ${pyRepr(v)}`), table);
  return h("div", { class: "card", id: "data-card" },
    h("h3", {}, title),
    h("div", { class: "data-literal" }, `${data.name} = ${pyRepr(v)}`),
    table);
}

function codePanel(code, { cur = null, stop = null, id = "code-panel" } = {}) {
  const lines = code.split("\n");
  return h("div", { class: "code", id },
    ...lines.map((t, i) => h("div", {
      class: "ln" + (i + 1 === stop ? " stop" : i + 1 === cur ? " cur" : ""), "data-line": i + 1,
    }, h("span", { class: "n" }, i + 1), h("span", { class: "t" }, t || " "))));
}

function editor(initial, id = "editor") {
  const ta = h("textarea", { id, spellcheck: "false", autocapitalize: "off", autocomplete: "off" });
  ta.value = initial;
  const gutter = h("div", { class: "gutter" });
  // lines wrap (Task 110), so each line number is padded by the extra visual rows its line takes
  const mirror = h("div", { class: "editor-mirror", "aria-hidden": "true" });
  const sync = () => {
    const lines = ta.value.split("\n");
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22.5;
    let rows = lines.map(() => 1);
    if (ta.clientWidth > 0 && mirror.isConnected) {
      mirror.style.width = ta.clientWidth + "px";
      fill(mirror, ...lines.map((t) => h("div", {}, t || " ")));
      rows = [...mirror.children].map((d) => Math.max(1, Math.round(d.offsetHeight / lh)));
    }
    gutter.textContent = lines.map((_, i) => String(i + 1) + "\n".repeat(rows[i] - 1)).join("\n");
    gutter.scrollTop = ta.scrollTop;
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(() => sync()).observe(ta);
  ta.addEventListener("input", sync);
  ta.addEventListener("scroll", sync);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 4; sync();
    }
  });
  sync();
  return h("div", { class: "editor" }, gutter, ta, mirror);
}

// a code card's heading: "name = literal", or (Task 192) a block's own title when it has no named data
function dataHeading(data) { return data && data.name ? `${data.name} = ${pyRepr(data.value)}` : (data && data.title) || "The program"; }
function iterLabel(it) {
  if (it === 0) return "before the loop";
  if (it === "after") return "after the loop";
  return `iteration ${it}`;
}
function predText(cp, p) {
  if (p == null) return "(no prediction)";
  if (cp.kind === "outcome") {
    const c = cp.choices[p.choice];
    return c ? c.label + (p.which ? ` (${p.which})` : "") : "(no prediction)";
  }
  return String(p);
}

// ------------------------------------------------------------------ HOME
async function home() {
  stopTimer();
  beat("home");
  R = null;
  const d = await api("/api/home");
  introSeen = d.intro_seen || [];
  stage({ speaker: "vesper", bubble: d.due.length ? "Some old jobs are back for a cold run. Start there?" : "Pick a job when you're ready." });
  // Task 112: the list is grouped (Python basics / Interview patterns / Combos / Graphs / LeetCode), every row
  // has one design whatever its state, and a slim up-next card sits on top when a recheck is due.
  const problems = [...d.problems].sort((a, b) => a.id.localeCompare(b.id));
  const byId = Object.fromEntries(problems.map((p) => [p.id, p]));
  const items = Object.fromEntries(d.items.map((it) => [it.problem_id, it]));
  const stateOf = (pid) => d.due.includes(pid) ? "due" : items[pid] ? (items[pid].closed ? "done" : "in-progress") : "new";
  const STATE_LABEL = { new: "new", "in-progress": "in progress", due: "due for recheck", done: "done" };
  const BASICS = new Set(["variables-assignment", "numbers-operators", "strings-slicing", "strings-methods", "booleans-logic",
    "conditionals", "for-range", "while-loops", "lists-indexing", "lists-sorting", "dict-counting", "dict-accumulation",
    "dict-iteration", "grouping-into-lists", "sets", "tuples-unpacking", "functions-return", "functions-mutable-default",
    "comprehensions", "enumerate-zip", "nested-data", "classes"]);
  // Task 123: graph problems (skill "graph-…") are a track of their own, not the tail of Interview patterns
  const groupOf = (p) => p.section === "leetcode" ? "leetcode" : (p.skill || "").startsWith("combo-") ? "combos"
    : (p.skill || "").startsWith("graph") ? "graphs" : BASICS.has(p.skill) ? "basics" : "patterns";
  const label = (p) => p.section === "leetcode" && p.lc ? `#${p.lc.number} · ${p.lc.title} · ${p.lc.difficulty}` : p.title;
  const row = (p) => {
    const st = stateOf(p.id);
    return h("div", { class: "problem", "data-id": p.id, "data-state": st },
      h("div", { class: "p-main" }, h("span", { class: "title" }, label(p)), h("span", { class: "tag" }, (p.skill || "").replace(/-/g, " "))),
      h("span", { class: `state state-${st}` }, STATE_LABEL[st]),
      h("div", { class: "p-actions" },
        h("button", { class: "btn", id: `start-${p.id}`, onclick: () => start(p.id, "teach") }, "Start"),
        h("button", { class: "link cold", id: `cold-${p.id}`, onclick: () => start(p.id, "cold", true) }, "Cold run")));
  };
  // every group starts closed; one slim card on top says what's next: a due recheck, else the next new problem
  const nodes = [];
  if (d.due.length) {
    const [first, ...rest] = d.due;
    nodes.push(h("div", { class: "card upnext", id: "rechecks" },
      h("h3", {}, "Up next — recheck due"),
      h("div", { class: "upnext-row" },
        h("span", { class: "title" }, byId[first] ? label(byId[first]) : first),
        h("button", { class: "btn", id: "upnext-cold", onclick: () => start(first, "cold", false) }, "Cold run")),
      rest.length ? h("small", { class: "muted" }, `+ ${rest.length} more due — marked below`) : null));
  } else {
    const next = problems.find((p) => stateOf(p.id) === "new");
    if (next) nodes.push(h("div", { class: "card upnext", id: "up-next" },
      h("h3", {}, d.items.length ? "Continue" : "Start here"),  // Task 174 (G4, #11): nothing to continue yet at 0 items
      h("div", { class: "upnext-row" },
        h("span", { class: "title" }, label(next)),
        h("button", { class: "btn", id: "upnext-start", onclick: () => start(next.id, "teach") }, "Start"))));
  }
  const group = (key, title, id) => {
    const list = problems.filter((p) => groupOf(p) === key);
    if (!list.length) return null;
    return h("details", { class: "card group", id },
      h("summary", {}, h("span", { class: "g-title" }, title), h("span", { class: "g-count" }, `${list.length}`)),
      ...list.map(row));
  };
  // Task 140: the arena entry — any problem, just the job, the data and your code (no lesson loop)
  nodes.push(h("div", { class: "card upnext", id: "arena-entry" },
    h("h3", {}, "Just solve it"),
    h("div", { class: "upnext-row" },
      h("span", { class: "title" }, "Any problem — the job, the data, your code."),
      h("button", { class: "btn", id: "arena-open", onclick: arenaList }, "Open"))));
  // Scratch S1: the Scratch Pad entry — its own page (scratch.html, relative so both builds serve it)
  nodes.push(h("div", { class: "card upnext", id: "scratch-entry" },
    h("h3", {}, "Scratch Pad"),
    h("div", { class: "upnext-row" },
      h("span", { class: "title" }, "Your code, any input — watch it run step by step."),
      h("button", { class: "btn", id: "scratch-open", onclick: () => location.assign("scratch.html") }, "Open"))));
  nodes.push(h("div", { id: "jobs", class: "groups" },
    group("basics", "Python basics", "group-basics"),
    group("patterns", "Interview patterns", "group-patterns"),
    group("combos", "Combos", "group-combos"),
    group("graphs", "Graphs", "group-graphs")));
  const lcGroup = group("leetcode", "LeetCode", "leetcode");
  if (lcGroup) nodes.push(lcGroup);
  if (d.items.length) {
    // Task 172 (slice G2, #24 + #20): one entry on the shelf — d.items[0], the most recently practised
    // (/api/home sorts most-recent-first, Task 171). The rest wait under "All N", rendered only when N > 1.
    // Task 173 (slice G3, #26 b): no date line on the shelf — the due date lives in #rechecks; the evidence
    // (stamp + one-liner) stays.
    const entry = (it) => h("div", { class: "oneliner" },
      it.closed ? h("span", { class: "stamp" }, "cold-passed") : null,
      it.one_liner);
    nodes.push(h("div", { class: "card", id: "evidence" },
      h("h3", {}, "Your evidence"),
      h("div", { class: "shelf" }, entry(d.items[0])),
      d.items.length > 1 ? h("details", { id: "evidence-all" }, h("summary", {}, `All ${d.items.length}`),
        h("div", { class: "shelf" }, ...d.items.slice(1).map(entry))) : null));
  }
  show(...nodes);
}

// ------------------------------------------------------------------ ARENA (Task 140): "Just solve it"
// No lesson loop — no intro, predictions, clarify, explainer or stage. The job, the visible test
// (the check whose input is the problem's main data — Task 143), an editor and Run. Run checks the visible test only,
// through /api/checks; nothing is recorded (no /api/attempt), so progress.json is never written.
function arenaBeat() {
  stopTimer();
  R = null;
  resetTrail();
  document.getElementById("stage-link")?.remove();
  document.body.dataset.beat = "arena";
  $("#beat-label").textContent = "· just solve it";
}
// Task 142: solved marks — client-side only (localStorage), never recorded on the server. Solved = a
// Submit whose hidden reveal is all-pass. Sticky: a later failing Submit never clears it.
const ARENA_SOLVED_KEY = "goat-arena-solved";
function arenaSolved() {
  try {
    const v = JSON.parse(localStorage.getItem(ARENA_SOLVED_KEY) || "[]");
    return new Set(Array.isArray(v) ? v.map(String) : []);
  } catch { return new Set(); }
}
function arenaMarkSolved(pid) {
  const s = arenaSolved();
  if (s.has(pid)) return;
  s.add(pid);
  try { localStorage.setItem(ARENA_SOLVED_KEY, JSON.stringify([...s])); } catch { /* storage unavailable: no mark, no harm */ }
}
// the mark itself: the existing match styling (`.checks .ok`), no new CSS
const solvedMark = () => h("span", { class: "checks arena-solved" }, h("span", { class: "ok" }, "✓ Solved"));
async function arenaList() {
  arenaBeat();
  const d = await api("/api/home");
  stage({ speaker: "vesper", bubble: "Pick any problem. No lesson this time — the job, the data, and your code." });
  const problems = [...d.problems].sort((a, b) => a.id.localeCompare(b.id));
  const label = (p) => p.section === "leetcode" && p.lc ? `#${p.lc.number} · ${p.lc.title} · ${p.lc.difficulty}` : p.title;
  const solved = arenaSolved();
  show(h("div", { class: "row" }, h("button", { class: "link", id: "arena-home", onclick: home }, "◀ Back to jobs")),
    h("div", { class: "card", id: "arena-list" },
      h("h3", {}, `Just solve it — ${problems.length} problems`),
      ...problems.map((p) => h("div", { class: "problem", "data-id": p.id },
        h("div", { class: "p-main" }, h("span", { class: "title" }, label(p), solved.has(p.id) ? [" ", solvedMark()] : null),
          h("span", { class: "tag" }, (p.skill || "").replace(/-/g, " "))),
        h("div", { class: "p-actions" },
          h("button", { class: "btn", id: `arena-${p.id}`, onclick: () => arenaSolve(p.id) }, "Solve"))))));
}
// Task 143: the visible test is the check whose input deep-equals the problem's main data
// ({ [data.name]: data.value }) — not checks[0], which is an edge case on 23 problems (002: sales = []).
// Every problem's main data is among its checks; if one ever weren't, fall back to checks[0].
function canonJSON(v) {
  if (Array.isArray(v)) return "[" + v.map(canonJSON).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonJSON(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
function arenaVisibleIndex(p) {
  const main = canonJSON({ [p.data.name]: p.data.value });
  const i = (p.checks || []).findIndex((c) => canonJSON(c.input) === main);
  return i >= 0 ? i : 0;
}
async function arenaSolve(pid) {
  arenaBeat();
  const p = await api(`/api/problem/${pid}`);
  if (p.error || !(p.checks && p.checks.length)) {
    show(h("div", { class: "card" }, h("p", {}, p.error || "This problem has no test to run.")),
      h("div", { class: "row" }, h("button", { class: "btn", id: "arena-back", onclick: arenaList }, "◀ All problems")));
    return;
  }
  stage({ speaker: "none" });
  const vi = arenaVisibleIndex(p);
  const test = p.checks[vi];
  const [name, value] = Object.entries(test.input)[0];
  const expectedText = test.expected === "" ? "(nothing printed)" : test.expected;
  const lines = p.scenario.split("\n");
  const markSlot = h("span", { id: "arena-solved-slot" }, arenaSolved().has(p.id) ? [" ", solvedMark()] : null);
  const job = h("div", { class: "card", id: "arena-job" }, h("h3", {}, p.title, markSlot),
    h("p", {}, ...lines.flatMap((t, i) => (i ? [h("br"), t] : [t]))));
  const ed = editor("", "arena-editor");
  const out = h("div", { id: "arena-out" });
  const run = h("button", { class: "btn", id: "arena-run", onclick: async () => {
    const code = ed.querySelector("textarea").value;
    if (!code.trim()) return;
    run.disabled = true;
    let res;
    try { res = await api("/api/checks", { problem_id: p.id, code, checks: [test] }); } finally { run.disabled = false; }
    if (codeNow() !== code) return;  // edited while it ran: that result describes code no longer here
    const r = res && res.results && res.results[0];
    if (!r) return fill(out, h("div", { class: "card" }, h("p", {}, "Couldn't run that — try again.")));
    fill(out, h("div", { class: "card", id: "arena-result" },
      h("h3", {}, "Your run"),
      h("p", {}, h("b", {}, "Your output: "), h("code", { id: "arena-got" }, r.got)),
      h("p", {}, h("b", {}, "Expected: "), h("code", { id: "arena-expected" }, expectedText)),
      h("ul", { class: "checks" }, h("li", { id: "arena-verdict", class: r.pass ? "pass" : "fail" },
        h("span", { class: r.pass ? "ok" : "notyet" }, r.pass ? "Match" : "No match yet"),
        r.pass ? " — your output is the expected output." : " — your output differs from the expected output."))));
  } }, "Run");
  // Task 141: Submit runs the HIDDEN tests (every check but the visible one — Task 143) — never executed or shown before this click
  const hiddenOut = h("div", { id: "arena-submit-out" });  // empty until Submit — no hint before
  // Task 144: a result card never outlives the code it was run against — any edit clears both the
  // Run card and the hidden reveal. The solved mark is about the problem, so it stays.
  const codeNow = () => ed.querySelector("textarea").value;
  ed.querySelector("textarea").addEventListener("input", () => { fill(out); fill(hiddenOut); });
  const submit = h("button", { class: "btn ghost", id: "arena-submit", onclick: async () => {
    const code = ed.querySelector("textarea").value;
    if (!code.trim()) return;
    const hidden = p.checks.filter((_, i) => i !== vi);  // every other check — the visible one isn't counted again
    if (!hidden.length) return fill(hiddenOut, h("div", { class: "card", id: "arena-hidden" }, h("p", {}, "No hidden tests on this one.")));
    fill(hiddenOut);  // a re-submit never shows a stale reveal
    submit.disabled = true;
    let res;
    try { res = await api("/api/checks", { problem_id: p.id, code, checks: hidden }); } finally { submit.disabled = false; }
    if (codeNow() !== code) return;  // edited while it ran (Task 144)
    const rs = res && Array.isArray(res.results) ? res.results : null;
    if (!rs) return fill(hiddenOut, h("div", { class: "card" }, h("p", {}, "Couldn't run the hidden tests — try again.")));
    const shown = (t) => (t === "" ? "(nothing printed)" : t);
    if (rs.length && rs.every((r) => r.pass)) {  // all hidden tests pass: solved (sticky)
      arenaMarkSolved(p.id);
      if (!markSlot.childNodes.length) markSlot.append(" ", solvedMark());
    }
    fill(hiddenOut, h("div", { class: "card", id: "arena-hidden" },
      h("h3", {}, "Hidden tests"),
      h("p", { id: "arena-hidden-summary" }, `${rs.filter((r) => r.pass).length} of ${rs.length} hidden tests pass.`),
      h("ul", { class: "checks" }, ...rs.map((r, i) => h("li", { class: r.pass ? "pass" : "fail", "data-hidden": i + 1 },
        h("span", { class: r.pass ? "ok" : "notyet" }, `Hidden test ${i + 1}: ${r.pass ? "pass" : "not yet"}`),
        h("div", {}, "Input: ", h("code", {}, Object.entries(r.input).map(([k, v]) => `${k} = ${pyRepr(v)}`).join(", "))),
        h("div", {}, "Expected: ", h("code", {}, shown(r.expected))),
        h("div", {}, "Your output: ", h("code", {}, shown(r.got))))))));
  } }, "Submit");
  show(h("div", { class: "row" }, h("button", { class: "link", id: "arena-back", onclick: arenaList }, "◀ All problems")),
    job,
    dataCard({ name, value }, "The data (the visible test)"),
    h("div", { class: "card", id: "arena-expect" }, h("h3", {}, "Expected output"), h("code", {}, expectedText)),
    h("div", { class: "card" }, h("h3", {}, `Your code (the data is already in ${name})`), ed,
      h("div", { class: "row mt" }, run, submit)),
    out, hiddenOut);
}

let introSeen = [];
async function start(pid, mode, manual) {
  const problem = await api(`/api/problem/${pid}`);
  if (problem.error) {
    stage({ speaker: "vesper", bubble: "I can't find that job's file. Nothing you did." });
    show(h("div", { class: "card", id: "problem-error" }, h("h3", {}, "Problem not found"), h("p", {}, problem.error)),
      h("div", { class: "row" }, h("button", { class: "btn", id: "go-home", onclick: home }, "Back to jobs")));
    return;
  }
  R = newRound(problem, mode, manual);
  resetTrail();
  // kit stage scenes exist for 001, 003, 010 and 132 (Tasks 90, 16, 119): offer the link there, nowhere else
  document.getElementById("stage-link")?.remove();
  if (["001", "003", "010", "132"].includes(pid)) document.querySelector("header.top")?.append(
    h("a", { id: "stage-link", class: "stage-link", href: `stage.html?p=${pid}` }, "Watch the stage"));
  // the intro is the lesson; cold runs are the exam, so they never see it
  // Task 192 (Flow R2a): a flow problem's teach run starts by taking the job apart — no intro, no trick up front
  if (mode === "teach" && problem.flow === "blocks") beatDissect();
  else if (mode === "teach" && problem.intro) beatIntro();
  else beatOpen();
}

// ------------------------------------------------------------------ 0. INTRO (teaching only): job → idea → watch one
async function beatIntro() {
  beat("intro");
  const p = R.problem, it = p.intro;
  stage({ speaker: "vesper", bubble: "Before the job, one idea. Then you'll watch it run once." });
  const seenBefore = introSeen.includes(p.id);
  const w = it.watch;
  const trace = await api("/api/trace", { code: w.code, data: { [w.data.name]: w.data.value } });
  const player = miniPlayer(trace, w.code, w.trace_watch || p.trace_watch, w.data);
  const yourTurn = h("button", { class: "btn", id: "your-turn", onclick: async () => {
    await api("/api/intro_seen", { problem_id: p.id });
    if (!introSeen.includes(p.id)) introSeen.push(p.id);
    beatOpen();
  } }, "Your turn");
  show(
    seenBefore ? h("div", { class: "row" }, h("button", { class: "link", id: "skip-intro", onclick: beatOpen }, "Skip intro")) : null,
    // Task 164 (slice C3, #16): no job card here — the open beat's bubble reads the job in full next.
    // The rule stays visible; the detail waits behind "Why it works" so the player reaches the first screen.
    h("div", { class: "card intro-part", id: "intro-idea" }, h("h3", {}, "The idea"),
      h("p", { class: "idea-rule" }, it.idea.rule),
      h("details", { id: "idea-detail" }, h("summary", {}, "Why it works"), h("p", {}, it.idea.detail))),
    h("div", { class: "card intro-part", id: "intro-watch" }, h("h3", {}, "Watch one"),
      h("p", { class: "muted" }, "Different data, same idea. Step through it."), player),
    h("div", { class: "row" }, yourTurn));
}

// Task 131: a watched var's value at step idx. A call line's `after` is the callee's frame, so the caller's
// vars vanish while stepped inside a function — carry the last value seen at or before idx instead, marked
// stale (shown dimmed, never highlighted). "—" only when no step so far has carried it. changed: only when
// this step's own `after` carries v and it differs from `before`.
function watchedVal(steps, idx, v) {
  const s = steps[idx];
  if (s && v in s.after) return { value: s.after[v], stale: false, changed: s.before[v] !== s.after[v] };
  for (let i = idx - 1; i >= 0; i--) {
    if (steps[i] && v in steps[i].after) return { value: steps[i].after[v], stale: true, changed: false };
  }
  return { value: "—", stale: false, changed: false };
}
// A plain stepper over a computed trace (no predictions, no recording).
function miniPlayer(trace, code, watch, data) {
  const steps = trace.steps;
  let idx = -1, playing = null;
  const codeBox = h("div", {}), varsBox = h("div", { class: "vars", id: "watch-vars" });
  const back = h("button", { class: "btn ghost", id: "watch-back", onclick: () => go(idx - 1) }, "◀ Back");
  // Task 162 (slice C1, idea 1): Play is the primary, Step the ghost; row order unchanged.
  const fwd = h("button", { class: "btn ghost", id: "watch-fwd", onclick: () => go(idx + 1) }, "Step ▶");
  const play = h("button", { class: "btn", id: "watch-play", onclick: () => {
    if (playing) { clearInterval(playing); playing = null; play.textContent = "Play"; return; }
    play.textContent = "Pause";
    playing = setInterval(() => { if (!go(idx + 1)) { clearInterval(playing); playing = null; play.textContent = "Play"; } }, 700);
  } }, "Play");
  function render() {
    const s = steps[idx];
    fill(codeBox, codePanel(code, { cur: s ? s.line : null, id: "watch-code" }));
    fill(varsBox, 
      h("div", { class: "where", id: "watch-where" }, s ? [h("span", { class: "iter" }, iterLabel(s.iteration)), `line ${s.line}`] : "Press Step or Play"),
      h("table", {}, ...(s ? watch.map((v) => {
        const w = watchedVal(steps, idx, v);
        return h("tr", { class: w.stale ? "stale" : w.changed ? "changed" : "" },
          h("td", {}, v), h("td", { "data-watch": v }, w.value));
      }) : [])),
      s && s.stdout ? h("div", { class: "printed", id: "watch-printed" }, h("b", {}, "printed: "), s.stdout) : null,
      idx === steps.length - 1 ? h("p", { class: "muted", id: "watch-done" }, "That's the whole run.") : null);
    back.disabled = idx <= 0; fwd.disabled = idx >= steps.length - 1;
  }
  function go(i) { if (i < 0 || i > steps.length - 1) return false; idx = i; render(); return true; }
  render();
  // Task 164 (slice C3, #16): the controls sit above the code, so Play is in reach without scrolling.
  return h("div", {}, h("div", { class: "data-literal", id: "watch-data" }, `${data.name} = ${pyRepr(data.value)}`),
    h("div", { class: "row mt" }, back, fwd, play), codeBox, varsBox);
}

// ------------------------------------------------------------------ 1. OPEN
// Task 177 (slice G7, N1): a LeetCode job reads statement + "Write: …" in the bubble; the examples and
// constraints wait one tap away under the data card. Anything that doesn't fit the shape stays whole.
function splitLcJob(p) {
  const s = p.scenario || "";
  const ex = s.indexOf("\n\nExample 1:"), wr = s.indexOf("\n\nWrite:");
  if (p.section !== "leetcode" || ex < 0 || wr < ex) return { head: s, tail: null };
  return { head: s.slice(0, ex) + s.slice(wr), tail: s.slice(ex + 2, wr) };
}
function beatOpen() {
  beat("open");
  const p = R.problem;
  const job = splitLcJob(p);
  stage({ speaker: "vesper", bubble: job.head });
  const go = h("button", { class: "btn", id: "open-next", onclick: beatRestate }, "Got it");
  show(dataCard(p.data),
    job.tail ? h("details", { class: "card lc-more" }, h("summary", {}, "Show examples & constraints"),
      h("div", { style: "white-space: pre-line" }, job.tail)) : null,
    h("div", { class: "row" }, go));
  if (R.mode === "cold") startTimer(6 * 60);
}

// ------------------------------------------------------------------ 2. RESTATE
// Tap/choose (Task 102): pick the job from 3 plans (the model restatement, the draft's blueprint,
// another problem's job). The server sends options only; the pick is judged here by exact match.
// restate_text / restate_self_mark stay in the record but are no longer written.
function beatRestate() {
  beat(isFlow() ? "dissect" : "restate");
  stage({ speaker: "vesper", bubble: "Which of these is the job? Tap the plan that says what to do." });
  const p = R.problem;
  const box = h("div", { class: "card", id: "restate-options" }, h("p", { class: "muted" }, "Loading the plans…"));
  show(dataCard(p.data, undefined, { compact: true }), box);
  const verdict = (pick) => pick === p.model_restatement ? "That's the job."
    : pick === p.blueprint ? (isFlow() ? "That's a way to solve it — not what the job asks for." : "That's the blueprint I hand Claude — the draft follows it literally, bug and all.")
    : "That's another problem's job, not this one.";
  const load = async () => {
    let options = null;
    try {
      const r = await api("/api/plan-options", { problem_id: p.id });
      if (Array.isArray(r.options) && r.options.length === 3) options = r.options;
      // Task 192: on the flow path the blueprint must not render before the reveal — drop it from the choices
      if (options && isFlow()) options = options.filter((o) => o !== p.blueprint);
    } catch (e) { options = null; }
    if (!options) {
      fill(box, h("p", {}, "Couldn't load the plans."),
        h("button", { class: "btn", id: "restate-retry", onclick: () => {
          fill(box, h("p", { class: "muted" }, "Loading the plans…")); load(); } }, "Try again"));
      return;
    }
    const btns = options.map((opt, i) => h("button", {
      class: "btn ghost", id: `plan-opt-${i}`, style: "display:block;width:100%;text-align:left;margin:6px 0;white-space:normal",
      onclick: () => {
        for (const b of btns) b.disabled = true;
        btns[i].className = "btn";
        R.rec.restate_pick = i;
        R.rec.restate_correct = opt === p.model_restatement;
        append(h("div", { class: "card", id: "restate-check" },
          h("h3", {}, "How I'd put it"),
          h("p", {}, p.model_restatement),
          h("p", { id: "restate-verdict" }, h("b", {}, verdict(opt))),
          h("div", { class: "row" }, h("button", { class: "btn", id: "restate-continue", onclick: beatClarify }, "Continue"))));
      } }, opt));
    fill(box, ...btns);
  };
  load();
}

// ------------------------------------------------------------------ 3. CLARIFY
// Tap/choose (Task 100): the authored questions are chips up front; tapping one IS asking it.
// No typing path, no keyword matching. clarify_unprompted stays in the record but is no longer written.
function beatClarify() {
  beat(isFlow() ? "dissect" : "clarify");
  stage({ speaker: "vesper", bubble: "Anything you'd ask before you start? Tap a question — asking it is the job." });
  const log = h("div", { id: "clarify-log" });
  const answer = (q, a) => log.append(
    h("p", {}, h("b", {}, "You: "), q), h("p", {}, h("b", {}, isFlow() ? "Answer: " : "Vesper: "), a));
  const chips = h("div", { id: "clarify-common" },
    ...R.problem.clarify.map((c, i) => h("button", { class: "btn ghost", id: `clarify-chip-${i}`, style: "margin:4px 6px 4px 0", onclick: (e) => {
      e.currentTarget.disabled = true;
      R.rec.clarify_asked.push(c.question);
      if (!R.rec.clarify_prompted.includes(i)) R.rec.clarify_prompted.push(i);
      answer(c.question, c.answer); stage({ speaker: "vesper", bubble: c.answer });
    } }, c.question)));
  const next = h("button", { class: "btn", id: "clarify-done", onclick: () => (R.mode === "cold" ? beatWriteCold() : isFlow() ? beatInstinct() : beatPlan()) },
    R.mode === "cold" || isFlow() ? "Ready to write it" : "Ready to plan");
  show(dataCard(R.problem.data, undefined, { compact: true }),
    h("div", { class: "card" }, log, chips),
    h("div", { class: "row" }, next));
}

// ------------------------------------------------------------------ 4. PLAN (teaching only)
function beatPlan() {
  // Task 168 (slice E1, idea 4): no typed plan — it was stored and never read. The beat opens on the
  // blueprint reveal (what used to appear after "That's my plan"); "Predict what it does" is its one tap.
  beat("plan");
  R.rec.plan_text = "";
  stage({ speaker: "claude", bubble: "Building exactly what the blueprint says. Literally.", other: "Here's the blueprint I'm handing Claude: " + R.problem.blueprint });
  show(dataCard(R.problem.data, undefined, { compact: true }), h("div", { class: "card", id: "blueprint" },
    h("h3", {}, "Blueprint → Claude's draft"),
    h("p", {}, R.problem.blueprint),
    codePanel(R.problem.draft_code, { id: "draft-code" }),
    h("div", { class: "row mt" },
      h("button", { class: "btn", id: "to-predict", onclick: () => beatPredict("draft") }, "Predict what it does"))));
}

// ------------------------------------------------------------------ 5. PREDICT (one checkpoint at a time, locked)
function predictSequence({ code, data, checkpoints, intro, onDone, choices, other = "", phase, label }) {
  beat("predict", label || CYCLE_NAMES.predict[phase]);
  stage({ speaker: "claude", bubble: intro || "Before I run anything — your call first.", other });
  const locked = h("ul", { class: "locked", id: "locked" });
  const slot = h("div", { id: "predict-slot" });
  const preds = {};
  let i = 0;
  // tap/choose (Task 99): value checkpoints get 3 options from /api/choices, fetched once per
  // sequence; any checkpoint without options (or a failed fetch) falls back to typing
  let options = {};
  const ready = choices ? api("/api/choices", choices).then((r) => { options = (r && r.choices) || {}; }).catch(() => {})
    : Promise.resolve();
  const askNext = () => {
    if (i >= checkpoints.length) { fill(slot, ); onDone(preds); return; }
    const cp = checkpoints[i];
    let getValue, tapToLock = false;
    const body = [];
    if (cp.kind === "outcome") {
      const which = h("input", { type: "text", id: "which-input", placeholder: "Which one? (optional)", hidden: true });
      const radios = cp.choices.map((c, ci) => h("label", {},
        h("input", { type: "radio", name: "choice", value: ci, onchange: () => { which.hidden = !c.ask_which; } }), " ", c.label));
      body.push(h("div", { class: "choices" }, ...radios), which);
      getValue = () => {
        const sel = slot.querySelector("input[name=choice]:checked");
        if (!sel) return null;
        const choice = Number(sel.value);
        return { choice, which: cp.choices[choice].ask_which ? which.value.trim() : "" };
      };
    } else if (Array.isArray(options[cp.id]) && options[cp.id].length) {
      // Task 161 (slice B1, idea 2): pick = lock. The tap is the lock: the pick pulse (160 ms) plays, then
      // lock() runs; there is no "Lock it in" here. Double-tap guard: the first tap sets `picked` (later taps
      // return) and disables the OTHER options — the picked one stays enabled so :disabled's .4 opacity
      // doesn't dim its pulse. `lock` is declared below; it's only called from the timeout, after it exists.
      let picked = null;
      tapToLock = true;
      const btns = options[cp.id].map((opt, oi) => {
        const b = h("button", { type: "button", class: "btn ghost opt", id: `opt-${oi}`, "aria-pressed": "false",
          onclick: () => {
            if (picked != null) return;
            picked = opt;
            for (const o of btns) { o.className = "btn ghost opt"; o.setAttribute("aria-pressed", "false"); if (o !== b) o.disabled = true; }
            b.className = "btn opt"; b.setAttribute("aria-pressed", "true");
            setTimeout(lock, 180);
          } }, h("code", {}, opt));
        return b;
      });
      body.push(h("div", { class: "choices opts", id: "predict-options" }, ...btns));
      getValue = () => picked;
    } else {
      const inp = h("input", { type: "text", id: "predict-input", placeholder: "Type the value, like Python would show it" });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") lock(); });
      body.push(inp);
      getValue = () => (inp.value.trim() ? inp.value.trim() : null);
    }
    const lock = () => {
      const v = getValue(); if (v == null) return;
      preds[cp.id] = v;
      locked.append(h("li", {}, `${cp.prompt} `, h("b", {}, "You said: "), h("code", {}, predText(cp, v))));
      i += 1; askNext();
    };
    fill(slot, h("div", { class: "card pred", id: `pred-${cp.id}` },
      h("div", { class: "prompt" }, cp.prompt), ...body,
      tapToLock ? null : h("div", { class: "row mt" }, h("button", { class: "btn", id: "lock-btn", onclick: lock }, "Lock it in"))));
    slot.querySelector("input")?.focus?.();
  };
  show(h("div", { class: "card" }, h("h3", {}, dataHeading(data)), codePanel(code)),
    h("div", { class: "card" }, h("h3", {}, "Your predictions (locked)"), locked), slot);
  ready.then(askNext);
}

function beatPredict(phase) {
  const p = R.problem;
  const cps = p.checkpoints.filter((c) => c.phase === phase);
  const code = phase === "draft" ? p.draft_code : p.fix.recommended;
  predictSequence({
    code, data: p.data, checkpoints: cps, phase,
    choices: { problem_id: p.id, phase, code, data: { [p.data.name]: p.data.value } },
    intro: phase === "draft" ? "Before I run anything — your call first." : "Here's the simplest version. Trace it in your head first.",
    onDone: async (preds) => {
      const ev = await api("/api/evaluate", { problem_id: p.id, phase, code, data: { [p.data.name]: p.data.value }, predictions: preds });
      beatExecute({ code, data: p.data, cps, preds, ev, phase,
        onDone: () => (phase === "draft" ? beatDivergence(ev, cps) : beatVerdict()) });
    },
  });
}

// ------------------------------------------------------------------ 6. EXECUTE (step through the real trace)
function beatExecute({ code, data, cps, preds, ev, phase, onDone, watch, label }) {
  beat("execute", label || CYCLE_NAMES.execute[phase]);
  const trace = ev.trace;
  // Task 125 (FE): a runaway trace (stopped at the step limit) shows its first 12 steps, then ONE closing
  // step — the real last step, carrying the StepLimit error — with a cut marker. Normal traces: every step.
  // Checkpoint reveals still key on raw step indexes: the first 12 match, later ones reveal at the end.
  const RUNAWAY_SHOWN = 12;
  const runaway = trace.stopped === "step_limit" && trace.steps.length > RUNAWAY_SHOWN + 1;
  const skipped = runaway ? trace.steps.length - RUNAWAY_SHOWN - 1 : 0;
  const steps = runaway
    ? [...trace.steps.slice(0, RUNAWAY_SHOWN), Object.assign({}, trace.steps[trace.steps.length - 1], { cut: true })]
    : trace.steps;
  watch = watch || R.problem.trace_watch;
  for (const r of ev.results) {
    R.rec.predictions.push({ id: r.id, phase, answer: predText(cps.find((c) => c.id === r.id), preds[r.id]),
      real: r.real, correct: r.correct, line: r.line, iteration: r.iteration });
  }
  stage({ speaker: "claude", bubble: "Running it now — one line at a time. You drive." });
  let idx = -1, playing = null;
  const revealed = new Set();
  const codeBox = h("div", {});
  const varsBox = h("div", { class: "card vars", id: "vars" });
  const reveals = h("div", { id: "reveals" });
  const back = h("button", { class: "btn ghost", id: "step-back", onclick: () => go(idx - 1) }, "◀ Back");
  // Task 162 (slice C1, idea 1): Play is the primary, Step the ghost; row order unchanged.
  const fwd = h("button", { class: "btn ghost", id: "step-fwd", onclick: () => go(idx + 1) }, "Step ▶");
  const play = h("button", { class: "btn", id: "step-play", onclick: () => {
    if (playing) { clearInterval(playing); playing = null; play.textContent = "Play"; return; }
    play.textContent = "Pause";
    playing = setInterval(() => { if (!go(idx + 1)) { clearInterval(playing); playing = null; play.textContent = "Play"; } }, 700);
  } }, "Play");
  const cont = h("button", { class: "btn", id: "exec-continue", disabled: true, onclick: () => { clearInterval(playing); onDone(); } }, "Continue");

  const revealCard = (r) => {
    const cp = cps.find((c) => c.id === r.id);
    const where = r.reached ? `line ${r.line}, ${iterLabel(r.iteration)}` : "";
    const tag = h("div", { class: "tag" }, r.correct ? `${r.id} — your trace matches Python's` : `${r.id} — your trace and Python's split here${where ? ": " + where : ""}`);
    // Task 163 (slice C2, #29): a match is just its tag line — "you said X, Python said X" repeats itself.
    // Splits keep the prompt and the You said / Python pair: that's the teaching payload.
    if (r.correct) return h("div", { class: "reveal match", "data-cp": r.id }, tag);
    return h("div", { class: "reveal split", "data-cp": r.id }, tag,
      h("div", {}, cp.prompt || ""),
      h("div", { class: "side" },
        h("div", {}, h("b", {}, "You said"), h("code", {}, predText(cp, preds[r.id]))),
        h("div", {}, h("b", {}, "Python"), h("code", {}, r.real))));
  };
  const revealFor = (i) => {
    const atEnd = i === steps.length - 1;
    for (const r of ev.results) {
      if (revealed.has(r.id)) continue;
      // reveal a checkpoint only once playback reaches its step; unreached ones reveal at the end
      if (r.step_index === i || atEnd) {
        // Task 162 (slice C1, idea 6): bring the new reveal into view; no smooth scroll under reduced motion
        const card = revealCard(r); revealed.add(r.id); reveals.append(card);
        card.scrollIntoView?.({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        if (playing) { clearInterval(playing); playing = null; play.textContent = "Play"; }
      }
    }
  };
  function render() {
    const s = steps[idx];
    const errLine = s && s.error ? s.line : null;
    fill(codeBox, codePanel(code, { cur: s ? s.line : null, stop: errLine }));
    const rows = [];
    if (s) {
      for (const v of watch) {
        const w = watchedVal(steps, idx, v);
        rows.push(h("tr", { class: w.stale ? "stale" : w.changed ? "changed" : "" }, h("td", {}, v), h("td", { "data-var": v }, w.value)));
      }
    }
    fill(varsBox, 
      h("div", { class: "where", id: "where" }, s ? [h("span", { class: "iter" }, iterLabel(s.iteration)), `line ${s.line}`] : "Not started — press Step"),
      h("table", {}, ...rows),
      s && s.stdout ? h("div", { class: "printed" }, h("b", {}, "printed: "), s.stdout) : null,
      s && s.cut ? h("p", { class: "muted", id: "cutnote" }, `…it keeps going like this — the loop never ends. (${skipped} more steps skipped.)`) : null,
      s && s.error ? h("div", { class: "stopnote", id: "stopnote" }, `Stopped: ${s.error.type}: ${s.error.message}`) : null,
      idx === steps.length - 1 && trace.timeout ? h("div", { class: "stopnote" }, trace.error.message) : null);
    back.disabled = idx <= 0;
    fwd.disabled = idx >= steps.length - 1;
  }
  function go(i) {
    if (i < 0 || i > steps.length - 1) return false;
    idx = i; render(); revealFor(i);
    if (idx === steps.length - 1) cont.disabled = false;
    return true;
  }
  const noSteps = steps.length === 0;
  show(h("div", { class: "split2" },
    h("div", { class: "card" }, h("h3", {}, dataHeading(data)), codeBox),
    varsBox),
    h("div", { class: "row" }, back, fwd, play, cont), reveals);
  render();
  if (noSteps) {
    varsBox.append(h("div", { class: "stopnote" }, trace.error ? `${trace.error.type}: ${trace.error.message}` : "Nothing ran."));
    for (const r of ev.results) { revealed.add(r.id); reveals.append(revealCard(r)); }
    cont.disabled = false;
  }
  R.lastTrace = trace;
}

// ------------------------------------------------------------------ 7. DIVERGENCE
function firstDivergence(results) {
  const misses = results.filter((r) => !r.correct);
  misses.sort((a, b) => (a.step_index ?? 1e9) - (b.step_index ?? 1e9));
  return misses[0] || null;
}
async function beatDivergence(ev, cps) {
  beat("divergence");
  const p = R.problem;
  const first = firstDivergence(ev.results);
  const nodes = [];
  if (first) {
    const cp = cps.find((c) => c.id === first.id);
    R.rec.first_divergence = { checkpoint: first.id, line: first.line, iteration: first.iteration,
      predicted: predText(cp, first.prediction), real: first.real };
    stage({ speaker: "claude", bubble: `Here's where your trace and mine split: line ${first.line}, ${iterLabel(first.iteration)}.` });
    nodes.push(h("div", { class: "card", id: "divergence" },
      h("h3", {}, "First divergence"),
      h("p", {}, `Line ${first.line}, ${iterLabel(first.iteration)}. That's the exact spot your mental run and Python's run went different ways.`),
      h("div", { class: "side" },
        h("div", {}, h("b", {}, "Your trace"), h("code", {}, predText(cp, first.prediction))),
        h("div", {}, h("b", {}, "Python's run"), h("code", {}, first.real)))));
    nodes.push(explainerCard(first, ev.trace, p));
  } else {
    stage({ speaker: "claude", bubble: "Your trace matched mine at every checkpoint." });
    nodes.push(h("div", { class: "card", id: "divergence" }, h("h3", {}, "No divergence"),
      h("p", {}, "You ran it in your head exactly the way Python did.")));
  }
  // separately: does the code do what we meant? (a bug is the code's, not yours)
  const checks = await api("/api/checks", { problem_id: p.id, code: p.draft_code });
  const err = ev.trace.error;
  if (err || !checks.all_pass) {
    nodes.push(h("div", { class: "card", id: "bug" },
      h("h3", {}, "Separately: the code has a bug"),
      h("p", {}, err ? `The draft stops on line ${err.line} with ${err.type}: ${err.message}. Claude did exactly what the blueprint said — not what we meant.`
        : "The draft runs, but doesn't do what we meant."),
      h("p", { class: "muted" }, "Why: " + p.why_line)));
  }
  nodes.push(h("div", { class: "row" }, h("button", { class: "btn", id: "to-fix", onclick: () => {
    const b = $("#bridge-answer");
    if (b) R.rec.bridge_answer = b.value.trim();
    beatFix();
  } }, "Fix it")));
  show(...nodes);
}

// Explainer at a prediction miss: the rule → the moment (micro-trace) → the bridge.
// Only ever shown on a miss; a matching prediction stays a fast path.
function explainerCard(first, trace, p) {
  const steps = trace.steps;
  const step = steps[first.step_index ?? steps.length - 1];
  const parts = [h("h3", {}, "What just happened")];
  // the authored rule + bridge belong to one checkpoint (the trap); other misses get moment + generic bridge
  const authored = p.explain && p.explain.checkpoint === first.id ? p.explain : null;
  if (authored) {
    parts.push(h("div", { class: "ex-part", id: "ex-rule" }, h("b", {}, "The rule"), h("p", {}, authored.rule)));
  }
  if (step) {
    const codeLine = R.problem.draft_code.split("\n")[step.line - 1].trim();
    const rows = p.trace_watch.map((v) => h("tr", {}, h("td", {}, v),
      h("td", { "data-before": v }, v in step.before ? step.before[v] : "(not set yet)")));
    let said;
    if (step.error) {
      said = `Python ran line ${step.line} and stopped with ${step.error.type}: ${step.error.message}, because ${p.why_line}`;
    } else {
      const changed = p.trace_watch.filter((v) => step.before[v] !== step.after[v]);
      said = `Python ran line ${step.line}, \`${codeLine}\`` + (changed.length
        ? `, and afterwards ${changed.map((v) => `${v} was ${step.after[v]}`).join(" and ")}.`
        : ", and nothing you're watching changed.");
    }
    parts.push(h("div", { class: "ex-part", id: "ex-moment" }, h("b", {}, "The moment"),
      h("div", { class: "where" }, h("span", { class: "iter" }, iterLabel(step.iteration)), `line ${step.line}`),
      h("div", { class: "code" }, h("div", { class: "ln stop" }, h("span", { class: "n" }, step.line), codeLine)),
      h("p", { class: "muted", style: "margin:8px 0 2px" }, "Just before the line ran:"),
      h("div", { class: "vars" }, h("table", {}, ...rows)),
      h("p", { id: "ex-said" }, said)));
  }
  const q = (authored && authored.bridge) || `Run line ${step ? step.line : first.line} again in your head with those values. What does it do now?`;
  parts.push(h("div", { class: "ex-part", id: "ex-bridge" }, h("b", {}, "The bridge"), h("p", {}, q),
    h("textarea", { id: "bridge-answer", placeholder: "Your thought — optional, nobody grades this." })));
  return h("div", { class: "card explainer", id: "explainer" }, ...parts);
}

// ------------------------------------------------------------------ 8. FIX
function hintBox(hints, onUse) {
  const box = h("div", { id: "hints" });
  const labels = ["Nudge", "Pointer", "Show me"];
  let used = 0;
  const btn = h("button", { class: "btn ghost", id: "hint-btn", onclick: () => {
    if (used >= hints.length) return;
    box.append(h("div", { class: "hint" }, h("b", {}, labels[used] + ": "), h("code", {}, hints[used])));
    used += 1; onUse(used);
    btn.textContent = used < hints.length ? `Hint: ${labels[used]}` : "No more hints";
    btn.disabled = used >= hints.length;
  } }, `Hint: ${labels[0]}`);
  return { node: h("div", {}, btn, box) };
}
function checksList(res) {
  return h("ul", { class: "checks", id: "checks-result" }, ...res.results.map((r) => h("li", { class: r.pass ? "pass" : "fail" },
    h("span", { class: r.pass ? "ok" : "notyet" }, r.pass ? "matches " : "not yet "),
    `${Object.entries(r.input).map(([k, v]) => `${k} = ${pyRepr(v)}`).join(", ")} → expected `, h("code", {}, r.expected),
    ", got ", h("code", {}, r.got))));
}
function beatFix() {
  beat("fix");
  const p = R.problem;
  stage({ speaker: "claude", bubble: "Your tools now. Make it do what we meant.", other: "Simplest working version wins." });
  const ed = editor(p.draft_code);
  const out = h("div", { id: "fix-out" });
  const hints = hintBox(p.fix.hints, (n) => { R.rec.hints_used = Math.max(R.rec.hints_used, n); });
  const run = h("button", { class: "btn", id: "run-checks", onclick: async () => {
    const code = ed.querySelector("textarea").value;
    const res = await api("/api/checks", { problem_id: p.id, code });
    fill(out, h("div", { class: "card", id: "checks-card" }, h("h3", {}, "Checks"), checksList(res)));
    if (res.all_pass) {
      R.rec.fix_passed = true; R.rec.fix_code = code; R.workingCode = code;
      run.disabled = true;
      stage({ speaker: "claude", bubble: "That works. Every check matches." });
      // Task 169 (slice F1, #23 + #27): the way on sits right under Checks, as a bare row outside any card;
      // the recommended version (shown in full on the next screen anyway) waits behind one closed summary,
      // which carries the heading — no h3 inside, so it never says the same thing twice.
      out.append(
        h("div", { class: "row mt" },
          h("button", { class: "btn", id: "to-predict-fixed", onclick: () => beatPredict("fixed") }, "Trace the simple version")),
        h("details", { class: "card", id: "fix-recommended" },
          h("summary", {}, "See the recommended version"),
          codePanel(p.fix.recommended, { id: "recommended-code" }),
          h("details", { id: "alternatives", class: "mt" }, h("summary", {}, "Alternatives (also fine — not first choice)"),
            ...p.fix.alternatives.map((a) => h("div", { class: "mt" }, h("p", { class: "muted" }, a.note), codePanel(a.code, { id: "" }))))));
    } else {
      stage({ speaker: "claude", bubble: "Not yet — look at the first check that doesn't match." });
    }
  } }, "Run checks");
  const fixEx = p.explain && p.explain.fix ? fixPatternCard(p) : null;
  show(fixEx, h("div", { class: "card" }, h("h3", {}, "Edit the code"), ed,
    h("div", { class: "row mt" }, run, hints.node)), out);
}

// The fix-pattern explainer: rule → walk (against iteration 1's real values) → contrast.
// It teaches the pattern; opening or collapsing it never touches hints_used.
function fixPatternCard(p) {
  const fx = p.explain.fix;
  const lines = p.fix.recommended.split("\n");
  const walkBox = h("div", { id: "fx-walk-rows" }, h("p", { class: "muted" }, "Loading the real values…"));
  api("/api/trace", { code: p.fix.recommended, data: { [p.data.name]: p.data.value } }).then((trace) => {
    if (!walkBox.isConnected) return; // he already left the Fix beat
    const firstIterStep = (line) => trace.steps.find((s) => s.line === line && (s.iteration === 1 || s.iteration === 0));
    fill(walkBox, ...fx.walk.map((w) => {
      const s = firstIterStep(w.line);
      let vals;
      if (!s) vals = h("span", { class: "muted" }, "runs once, after the loop");
      else {
        const changed = p.trace_watch.filter((v) => s.before[v] !== s.after[v]);
        vals = changed.length
          ? h("span", {}, ...changed.map((v, i) => [i ? " · " : "", h("code", { "data-fx-var": v, "data-fx-line": w.line },
              `${v}: ${v in s.before ? s.before[v] : "—"} → ${s.after[v]}`)]))
          : h("span", { class: "muted" }, "nothing changes");
      }
      return h("div", { class: "fx-row", "data-line": w.line },
        h("div", { class: "code" }, h("div", { class: "ln" }, h("span", { class: "n" }, w.line), lines[w.line - 1])),
        h("p", {}, w.gloss), h("p", { class: "fx-vals" }, s && s.iteration === 1 ? "iteration 1: " : s ? "before the loop: " : "", vals));
    }));
  });
  const c = fx.contrast;
  // Task 170 (slice F2, #22): starts closed — the pattern is one tap away behind its 44 px summary.
  return h("details", { class: "card explainer fixpattern", id: "fix-explainer" },
    h("summary", {}, "The pattern behind the fix"),
    h("div", { class: "ex-part", id: "fx-rule" }, h("b", {}, "The rule"), h("p", { class: "idea-rule" }, fx.rule)),
    h("div", { class: "ex-part", id: "fx-walk" }, h("b", {}, "Walk it — first time through"), walkBox),
    h("div", { class: "ex-part", id: "fx-contrast" }, h("b", {}, "Side by side"),
      h("div", { class: "side" },
        h("div", {}, h("b", {}, "The draft's way"), h("code", {}, c.wrong), h("p", { class: "muted" }, c.wrong_note || "")),
        h("div", {}, h("b", {}, "The fixed way"), h("code", {}, c.right), h("p", { class: "muted" }, c.right_note || "")))));
}

// ------------------------------------------------------------------ 9. VERDICT
const VERDICTS = {
  clean: ["Clean pass", "Every prediction matched Python's run, with no hints."],
  found: ["Divergence found", "You found exactly where your trace split from Python's, and the code works now."],
  helped: ["Helped pass", "You got there with hints. It comes back cold, so you can do it alone."],
  cold_pass: ["Cold pass", "Written alone, run in your head, and it works."],
  cold_helped: ["Works — with a hint", "It comes back again so you can do it with none."],
  cold_not_yet: ["Not closed yet", "The split is logged. It comes back soon for another cold run."],
};
async function beatVerdict() {
  beat("verdict");
  const p = R.problem;
  const { verdict } = await api("/api/verdict", R.rec);
  R.verdict = verdict;
  const [title, line] = VERDICTS[verdict];
  stage({ speaker: "vesper", bubble: verdict === "clean" || verdict === "cold_pass" ? "Nice. That's how it's done." : "Good find. That's the whole point." });
  const summary = h("ul", { class: "locked" }, ...R.rec.predictions.map((x) => h("li", {},
    h("b", {}, `${x.id}: `), x.correct ? "matched — " : "split — ", "you said ", h("code", {}, x.answer), ", Python: ", h("code", {}, x.real))));
  const next = R.mode === "cold"
    ? h("button", { class: "btn", id: "to-schedule", onclick: beatSchedule }, "Done")
    : h("button", { class: "btn", id: "to-followup", onclick: beatFollowUp }, "One more thing…");
  // G6c (Task 122): graph problems offer HIS run on the stage — built here only, never before the verdict.
  // run=fix always (the why-line belongs to the authored draft); a new tab, so his round stays open.
  // G6e (Task 128): offered only when his stream on the main data actually walks (>= 1 node_current),
  // the same guard as the follow-up pill — own-names code stages no walk. Any failure: no pill.
  // Task 158 (slice A1): the verdict paints first. The card, the one-liner and the row show as soon as
  // /api/verdict returns; the replay pill and the complexity race (Task 134) fill their slots when they
  // resolve, both started at once. A slot that has left the page (he moved on) is never filled.
  const raceSlot = h("div", { id: "race-slot" });
  const replaySlot = h("span", { id: "replay-slot" });
  show(h("div", { class: "card", id: "verdict" },
    h("p", { class: "verdict-title", "data-verdict": verdict }, title), h("p", {}, line), summary),
    raceSlot,
    h("div", { class: "oneliner", id: "oneliner" }, p.one_liner), h("div", { class: "row" }, next, replaySlot));
  const into = (slot) => (node) => { if (node && document.body.contains(slot)) fill(slot, node); };
  verdictReplay(p, R.workingCode).then(into(replaySlot), () => {});
  complexityRace(p).then(into(raceSlot), () => {});
}
// The race table: the draft and the fix on growing inputs (POST /api/complexity), rows and the ratio line
// computed from what the endpoint returns — nothing hardcoded. No complexity block, or any failure: null.
async function complexityRace(p) {
  if (!p.complexity) return null;
  let r;
  try { r = await api("/api/complexity", { problem_id: p.id }); } catch { return null; }
  const ok = r && Array.isArray(r.sizes) && r.sizes.length && ["draft_steps", "fix_steps"].every((k) =>
    Array.isArray(r[k]) && r[k].length === r.sizes.length && r[k].every((v) => Number.isFinite(v) && v > 0));
  if (!ok) return null;
  const last = r.sizes.length - 1, n = r.sizes[last], d = r.draft_steps[last], f = r.fix_steps[last];
  return h("div", { class: "card", id: "race" },
    h("h3", {}, "How the steps grow"),
    h("p", { id: "race-caption" }, "Same code, bigger lists: n is how many numbers are in."),
    h("table", { class: "data", id: "race-table" },
      h("tr", {}, h("th", {}, "n"), h("th", {}, "draft steps"), h("th", {}, "fix steps")),
      ...r.sizes.map((size, i) => h("tr", {}, h("td", {}, size), h("td", {}, r.draft_steps[i]), h("td", {}, r.fix_steps[i])))),
    h("p", { id: "race-ratio" }, `At n = ${n} the fix takes ${f} steps against the draft's ${d} — about ${Math.round(d / f)}x fewer.`),
    await raceFrames(p, r.sample_data));
}
// Task 136: a few sampled frames of both runs at the largest n — the steps at 1/4, 1/2 and 3/4 of each trace,
// with the problem's own trace_watch vars present in that step. Dicts and sets show as "N entries".
// Any failure (no sample_data, a trace error, empty steps): null, and the race card renders as before.
async function raceFrames(p, data) {
  if (!data || typeof data !== "object") return null;
  const runs = [["Draft", p.draft_code], ["Fix", p.fix && p.fix.recommended]];
  let traces;
  try { traces = await Promise.all(runs.map(([, code]) => api("/api/trace", { code, data }))); } catch { return null; }
  if (traces.some((t) => !t || t.error || !Array.isArray(t.steps) || !t.steps.length)) return null;
  const entries = (rep) => {  // top-level element count of a dict/set repr
    if (rep === "{}" || rep === "set()") return 0;
    let depth = 0, quote = null, n = 1;
    for (let i = 1; i < rep.length - 1; i++) {
      const c = rep[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; }
      else if (c === "'" || c === '"') quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 0) n++;
    }
    return n;
  };
  const show = (rep) => (/^\{.*\}$/s.test(rep) || rep === "set()") ? `${entries(rep)} entries` : rep;
  const watch = p.trace_watch || [];
  const nodes = [];
  runs.forEach(([label], k) => {
    const steps = traces[k].steps, N = steps.length;
    nodes.push(h("p", { class: "race-run" }, h("b", {}, label)));
    for (const at of [Math.floor(N / 4), Math.floor(N / 2), Math.floor(3 * N / 4)]) {
      const s = steps[at];
      const vars = watch.filter((v) => v in s.after).map((v) => `${v} = ${show(s.after[v])}`);
      nodes.push(h("div", { class: "printed race-frame" }, [`step ${at} of ${N}`, `line ${s.line}`, ...vars].join(" · ")));
    }
  });
  return h("div", { id: "race-frames" }, ...nodes);
}
async function verdictReplay(p, code) {
  if (p.stage?.device !== "graph" || !code) return null;
  let res;
  try {
    res = await api("/api/stage-stream", { problem_id: p.id, code, data: { [p.data.name]: p.data.value }, run: "fix" });
  } catch { return null; }
  const events = (res && res.streams && Object.values(res.streams)[0]) || [];
  if (!events.some((e) => e.type === "node_current")) return null;
  return h("a", { id: "replay-link", class: "stage-link", target: "_blank", rel: "noopener",
                  href: `stage.html?p=${p.id}&replay=fix&code=${base64url(code)}` }, "Watch your run on the stage");
}
// UTF-8 bytes -> btoa -> URL-safe alphabet, no padding (stage.html's replay decoder reverses it)
function base64url(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------------------------ 10. FOLLOW-UP
async function beatFollowUp() {
  beat("follow-up");
  const p = R.problem, fu = p.follow_up;
  const code = R.workingCode || p.fix.recommended;
  const cp = Object.assign({ phase: "follow_up" }, fu.checkpoint);
  stage({ speaker: "vesper", bubble: fu.prompt });
  predictSequence({
    code, data: fu.data, checkpoints: [cp], intro: "Same code, new data. Call it first.", other: fu.prompt, phase: "follow_up",
    choices: { problem_id: p.id, phase: "follow_up", code, data: { [fu.data.name]: fu.data.value }, checkpoints: [cp] },
    onDone: async (preds) => {
      stage({ speaker: "vesper", bubble: fu.prompt });
      const data = { [fu.data.name]: fu.data.value };
      const ev = await api("/api/evaluate", { problem_id: p.id, phase: "follow_up", code, data, checkpoints: [cp], predictions: preds });
      const before = R.rec.predictions.length;
      beatExecute({ code, data: fu.data, cps: [cp], preds, ev, phase: "follow_up", onDone: () => followUpFix(ev) });
      R.followPredictionIndex = before;
    },
  });
}
async function followUpFix(ev) {
  beat("follow-up");
  const p = R.problem, fu = p.follow_up;
  const fuPred = R.rec.predictions.splice(R.followPredictionIndex, 1)[0]; // follow-up is recorded separately
  const expected = await api("/api/trace", { code: fu.recommended, data: { [fu.data.name]: fu.data.value } });
  const want = expected.stdout.trim();
  const fuChecks = [{ input: { [fu.data.name]: fu.data.value }, expected: want }, ...p.checks];
  const done = (passed, code) => { R.rec.follow_up = { prediction: fuPred, passed, code }; beatSchedule(); };
  const mine = await api("/api/checks", { problem_id: p.id, code: R.workingCode, checks: fuChecks });
  if (mine.all_pass) {
    stage({ speaker: "vesper", bubble: "Your code already handles it. Nice." });
    const replay = await followUpReplay(p, R.workingCode);
    show(h("div", { class: "row" }, h("button", { class: "btn", id: "to-schedule", onclick: () => done(true, R.workingCode) }, "Done"), replay));
    return;
  }
  stage({ speaker: "vesper", bubble: `I'd want ${want} there. Can you make it do that?` });  // Task 175 (G5, #1): no problem-specific story here
  const ed = editor(R.workingCode, "fu-editor");
  const out = h("div", { id: "fu-out" });
  const hint = h("button", { class: "btn ghost", id: "fu-hint", onclick: () => { hint.disabled = true; out.prepend(h("div", { class: "hint" }, fu.fix_hint)); R.rec.follow_up_hint = true; } }, "Hint");
  const run = h("button", { class: "btn", id: "fu-run", onclick: async () => {
    const code = ed.querySelector("textarea").value;
    const res = await api("/api/checks", { problem_id: p.id, code, checks: fuChecks });
    fill(out, h("div", { class: "card", id: "checks-card" }, h("h3", {}, "Checks"), checksList(res)));
    if (res.all_pass) {
      run.disabled = true;
      stage({ speaker: "vesper", bubble: "That's the follow-up handled." });
      const replay = await followUpReplay(p, code);
      out.append(h("div", { class: "row mt" }, h("button", { class: "btn", id: "to-schedule", onclick: () => done(true, code) }, "Done"), replay));
    }
  } }, "Run checks");
  const skip = h("button", { class: "link", id: "fu-skip", onclick: () => done(false, ed.querySelector("textarea").value) }, "Leave it for now");
  show(dataCard(fu.data, "New data"), h("div", { class: "card" }, ed, h("div", { class: "row mt" }, run, hint, skip)), out);
}

// G6d (Task 124): the follow-up replay pill — his code on the follow-up's NEW data, run=fix, new tab.
// Offered only when his stream actually walks (>= 1 node_current): code with its own variable names
// stages no walk, and "watch your run" must show his walk. Any failure just means no pill.
async function followUpReplay(p, code) {
  if (p.stage?.device !== "graph" || !code) return null;
  const fu = p.follow_up, data = { [fu.data.name]: fu.data.value };
  let res;
  try { res = await api("/api/stage-stream", { problem_id: p.id, code, data, run: "fix" }); } catch { return null; }
  const events = (res && res.streams && Object.values(res.streams)[0]) || [];
  if (!events.some((e) => e.type === "node_current")) return null;
  return h("a", { id: "fu-replay-link", class: "stage-link", target: "_blank", rel: "noopener",
                  href: `stage.html?p=${p.id}&replay=fix&code=${base64url(code)}&data=${base64url(JSON.stringify(data))}` },
    "Watch your run on the stage");
}

// ------------------------------------------------------------------ COLD: write it yourself
function beatWriteCold() {
  beat("write");
  const p = R.problem;
  stage({ speaker: "vesper", bubble: "Blank page. Write the simplest thing that does the job." });
  const ed = editor("", "cold-editor");
  const hints = hintBox(p.fix.hints, (n) => { R.rec.hints_used = Math.max(R.rec.hints_used, n); });
  const btn = h("button", { class: "btn", id: "cold-done", onclick: () => {
    const code = ed.querySelector("textarea").value;
    if (!code.trim()) return;
    R.workingCode = code; R.rec.fix_code = code;
    const cp = { id: "C1", phase: "cold", at: "end", kind: "value", prompt: "What will your code print?" };
    predictSequence({
      code, data: p.data, checkpoints: [cp], intro: "Now run it in your head. What prints?", phase: "cold",
      onDone: async (preds) => {
        const data = { [p.data.name]: p.data.value };
        const ev = await api("/api/evaluate", { problem_id: p.id, phase: "cold", code, data, checkpoints: [cp], predictions: preds });
        beatExecute({ code, data: p.data, cps: [cp], preds, ev, phase: "cold", onDone: async () => {
          const res = await api("/api/checks", { problem_id: p.id, code });
          R.rec.fix_passed = res.all_pass;
          const first = firstDivergence(ev.results);
          if (first) R.rec.first_divergence = { checkpoint: first.id, line: first.line, iteration: first.iteration, predicted: predText(cp, first.prediction), real: first.real };
          await beatVerdict();
          // Task 159 (slice A2, #17): the count reads at a glance; the full list is one tap away.
          const passing = res.results.filter((r) => r.pass).length;
          work().prepend(h("div", { class: "card", id: "cold-checks" }, h("h3", {}, "Does it do the job?"),
            h("p", { id: "cold-checks-count" }, `${passing} of ${res.results.length} checks pass`),
            h("details", { id: "cold-checks-list" }, h("summary", {}, "Show the checks"), checksList(res))));
        } });
      },
    });
  } }, "Done — run it");
  show(dataCard(p.data), h("div", { class: "card" }, h("h3", {}, `Your code (the data is already in ${p.data.name})`), ed,
    h("div", { class: "row mt" }, btn, hints.node)));
}

// ------------------------------------------------------------------ FLOW (Task 192, Flow R2a; FLOW-REWORK-R1 §1–2)
// A teach run of a problem with "flow": "blocks": dissect → instinct (HIS working draft) → predict/execute on it →
// optimize-why → block ×N (tiny predict/run programs) → assemble (he orders the lines he earned) → predict/execute
// on HIS assembly → reveal (the recommended version's FIRST appearance) → verdict → follow-up → schedule.
// The recommended code is never rendered before beatReveal: no beatPredict("fixed"), no fixPatternCard, no
// #fix-recommended, no blueprint card, no intro.idea on this path.
const flowData = (p) => ({ [p.data.name]: p.data.value });
// variables to show for code the lesson didn't author a watch list for: every name the trace saw, first-seen order
function traceVars(trace) {
  const seen = [];
  for (const s of (trace && trace.steps) || []) for (const k of Object.keys(s.after || {})) if (!seen.includes(k) && !k.startsWith(".")) seen.push(k);
  return seen;
}

function beatDissect() {
  beat("dissect");
  const p = R.problem, d = p.dissect || {}, qs = d.questions || [];
  R.rec.dissect = [];
  stage({ speaker: "vesper", bubble: p.scenario });
  const box = h("div", { id: "dissect-qs" });
  const done = () => {
    const next = h("button", { class: "btn", id: "dissect-next", onclick: () => (d.restate === false ? beatClarify() : beatRestate()) }, "Continue");
    box.append(h("div", { class: "row mt" }, next));
  };
  const ask = (k) => {
    if (k >= qs.length) return done();
    const q = qs[k];
    const card = h("div", { class: "card", id: `dissect-${q.id}` }, h("div", { class: "prompt" }, q.prompt));
    const settle = (answerText, correct, real) => {
      R.rec.dissect.push({ id: q.id, answer: answerText, correct });
      card.append(h("p", { id: `dissect-${q.id}-check` }, h("b", {}, correct ? "Yes. " : "Not quite. "), real ? ["It's ", h("code", {}, real), "."] : null));
      ask(k + 1);
    };
    if (q.kind === "outcome") {
      const btns = q.choices.map((c, i) => h("button", { class: "btn ghost", id: `dissect-${q.id}-opt-${i}`, style: "display:block;width:100%;text-align:left;margin:6px 0;white-space:normal", onclick: () => {
        for (const b of btns) b.disabled = true; btns[i].className = "btn";
        settle(c.label, i === q.answer, i === q.answer ? null : q.choices[q.answer].label);
      } }, c.label));
      card.append(...btns);
    } else {
      const inp = h("input", { type: "text", id: `dissect-${q.id}-input`, placeholder: "Type it, like Python would show it" });
      const lockIt = async () => {
        const v = inp.value.trim(); if (!v) return;
        inp.disabled = true; lockBtn.disabled = true;
        if (q.kind === "by_hand") {
          // the real answer on this data: the recommended code's output — computed, never shown
          const cp = { id: q.id, phase: "dissect", at: "end", kind: "value", prompt: q.prompt };
          const ev = await api("/api/evaluate", { problem_id: p.id, phase: "dissect", code: p.fix.recommended, data: flowData(p), checkpoints: [cp], predictions: { [q.id]: v } });
          const r = (ev.results || [])[0] || {};
          settle(v, !!r.correct, r.correct ? null : r.real);
        } else {
          const norm = (t) => String(t).replace(/\s+/g, "");
          settle(v, norm(v) === norm(q.expected), norm(v) === norm(q.expected) ? null : q.expected);
        }
      };
      const lockBtn = h("button", { class: "btn", id: `dissect-${q.id}-lock`, onclick: lockIt }, "Lock it in");
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") lockIt(); });
      card.append(inp, h("div", { class: "row mt" }, lockBtn));
    }
    box.append(card);
  };
  show(dataCard(p.data), box);
  ask(0);
}

function beatInstinct() {
  beat("instinct");
  const p = R.problem, inst = p.instinct || {};
  stage({ speaker: "vesper", bubble: "Write the obvious way first — anything that finds the answer. Fast comes later." });
  const ed = editor(inst.scaffold || "", "instinct-editor");
  const out = h("div", { id: "instinct-out" });
  const hints = hintBox(inst.hints || [], (n) => { R.rec.hints_used = Math.max(R.rec.hints_used, n); R.rec.instinct_hints = n; });
  const run = h("button", { class: "btn", id: "instinct-run", onclick: async () => {
    const code = ed.querySelector("textarea").value;
    const res = await api("/api/checks", { problem_id: p.id, code });
    fill(out, h("div", { class: "card", id: "instinct-checks" }, h("h3", {}, "Checks"), checksList(res)));
    if (!res.all_pass) { stage({ speaker: "vesper", bubble: "Not yet — look at the first check that doesn't match." }); return; }
    R.rec.instinct_code = code; R.rec.instinct_passed = true;
    stage({ speaker: "vesper", bubble: "It works. Now run your own code in your head." });
    out.append(h("div", { class: "row mt" }, h("button", { class: "btn", id: "instinct-predict", onclick: () => {
      const cp = { id: "I1", phase: "instinct", at: "end", kind: "value", prompt: "What will your code print?" };
      predictSequence({
        code, data: p.data, checkpoints: [cp], phase: "instinct", intro: "Your code, this data. What prints?",
        onDone: async (preds) => {
          const ev = await api("/api/evaluate", { problem_id: p.id, phase: "instinct", code, data: flowData(p), checkpoints: [cp], predictions: preds });
          beatExecute({ code, data: p.data, cps: [cp], preds, ev, phase: "instinct", watch: traceVars(ev.trace), onDone: beatOptimizeWhy });
        },
      });
    } }, "Predict what it prints")));
  } }, "Run checks");
  show(dataCard(p.data, undefined, { compact: true }),
    h("div", { class: "card" }, h("h3", {}, "Your first version"), ed, h("div", { class: "row mt" }, run, hints.node)), out);
}

function beatOptimizeWhy() {
  beat("optimize");
  const why = (R.problem.instinct || {}).why || {};
  stage({ speaker: "vesper", bubble: "It's right. Now let's see what it costs." });
  show(h("div", { class: "card", id: "optimize-why" }, h("h3", {}, "How much work is that?"),
      why.this_data ? h("p", {}, why.this_data) : null, why.real_size ? h("p", {}, why.real_size) : null),
    h("div", { class: "row" }, h("button", { class: "btn", id: "to-blocks", onclick: () => beatBlock(0) }, "Let's make it faster")));
}

function beatBlock(i) {
  const p = R.problem, blocks = p.blocks || [], b = blocks[i];
  if (!b) return beatAssemble();
  const n = i + 1, of = blocks.length;
  const data = b.data && b.data.name ? b.data : { title: `Block ${n} of ${of}: ${b.title}` };
  const dataDict = b.data && b.data.name ? { [b.data.name]: b.data.value } : {};
  const cps = (b.checkpoints || []).map((c) => Object.assign({ phase: "block" }, c));
  beat("block", `Block ${n} of ${of}`);
  predictSequence({
    code: b.code, data, checkpoints: cps, phase: "block", label: `Predicting block ${n} of ${of}`,
    intro: `Block ${n}: ${b.title}. A tiny program — call it before it runs.`,
    choices: { problem_id: p.id, phase: "block", code: b.code, data: dataDict, checkpoints: cps },
    onDone: async (preds) => {
      const ev = await api("/api/evaluate", { problem_id: p.id, phase: "block", code: b.code, data: dataDict, checkpoints: cps, predictions: preds });
      beatExecute({ code: b.code, data, cps, preds, ev, phase: "block", label: `Watching block ${n} of ${of} run`, watch: b.watch || traceVars(ev.trace),
        onDone: () => {
          R.rec.blocks_done = [...new Set([...(R.rec.blocks_done || []), b.id])];
          beat("block", `Block ${n} of ${of}: the takeaway`);
          stage({ speaker: "vesper", bubble: b.teaches });
          show(h("div", { class: "card", id: `block-${b.id}-takeaway` }, h("h3", {}, `Block ${n}: ${b.title}`),
              h("p", { class: "idea-rule" }, b.teaches),
              b.tile ? [h("p", { class: "muted" }, "The line you earned:"), codePanel(b.tile, { id: `tile-${b.id}` })] : null),
            h("div", { class: "row" }, h("button", { class: "btn", id: "block-next", onclick: () => (n < of ? beatBlock(i + 1) : beatAssemble()) },
              n < of ? "Next block" : "Put it together")));
        } });
    },
  });
}

function beatAssemble() {
  beat("assemble");
  const p = R.problem, blocks = p.blocks || [], asm = p.assembly || {};
  const done = new Set(R.rec.blocks_done || []);
  const missing = blocks.filter((b) => !done.has(b.id));
  if (missing.length) {   // taught before assembly: no tiles until every block is done
    const first = blocks.indexOf(missing[0]);
    stage({ speaker: "vesper", bubble: "Every block first — then you put them together." });
    return show(h("div", { class: "card", id: "assemble-locked" }, h("h3", {}, "Locked"),
        h("p", {}, `${missing.length} block${missing.length === 1 ? "" : "s"} still to do.`)),
      h("div", { class: "row" }, h("button", { class: "btn", id: "assemble-to-block", onclick: () => beatBlock(first) }, "Go to the next block")));
  }
  stage({ speaker: "vesper", bubble: "Put the lines you earned in order. Tap a line, then a slot." });
  const slotsN = (asm.skeleton.match(/\{\d+\}/g) || []).length;
  const earned = blocks.filter((b) => b.tile && done.has(b.id));
  const order = earned.map((b, k) => ({ b, k: (k * 7 + 3) % (earned.length + 2) })).sort((x, y) => x.k - y.k).map((x) => x.b);
  const placed = Array(slotsN).fill(null);   // block ids per slot
  let picked = null, attempts = 0, hintsUsed = 0;
  R.rec.assembly_attempts = 0;
  const tray = h("div", { id: "assemble-tray", class: "choices" });
  const skel = h("div", { class: "code", id: "assemble-skeleton" });
  const out = h("div", { id: "assemble-out" });
  const hintsBox = h("div", { id: "assemble-hints" });
  const build = () => asm.skeleton.replace(/\{(\d+)\}/g, (_, n) => { const id = placed[Number(n) - 1]; const b = blocks.find((x) => x.id === id); return b ? b.tile : ""; });
  const render = () => {
    const lines = [];
    for (const raw of asm.skeleton.split("\n")) {
      const m = raw.match(/^\{(\d+)\}$/);
      if (m) {
        const si = Number(m[1]) - 1, id = placed[si], b = blocks.find((x) => x.id === id);
        lines.push(h("button", { type: "button", class: "btn ghost slot", id: `slot-${si + 1}`, "data-filled": id ? "1" : "0", style: "display:block;width:100%;text-align:left;font-family:var(--mono);white-space:pre",
          // tap a line then a slot: the line goes in (a line already there returns to the tray); tap a filled slot alone to empty it
          onclick: () => { if (picked) { placed[si] = picked; picked = null; render(); } else if (placed[si]) { placed[si] = null; render(); } } },
          b ? b.tile : `  — slot ${si + 1} —`));
      } else lines.push(h("div", { class: "ln" }, h("span", { class: "t" }, raw || " ")));
    }
    fill(skel, ...lines);
    fill(tray, ...order.filter((b) => !placed.includes(b.id)).map((b) => h("button", { type: "button", class: picked === b.id ? "btn tile" : "btn ghost tile", id: `tile-btn-${b.id}`, "data-block": b.id,
      style: "display:block;width:100%;text-align:left;font-family:var(--mono);white-space:pre;margin:6px 0", onclick: () => { picked = picked === b.id ? null : b.id; render(); } }, b.tile)));
    runBtn.disabled = placed.some((x) => !x);
  };
  const runBtn = h("button", { class: "btn", id: "assemble-run", onclick: async () => {
    const code = build();
    const t = await api("/api/trace", { code, data: flowData(p) });
    if (t.error && ["SyntaxError", "IndentationError"].includes(t.error.type)) {   // not valid Python: not an attempt
      fill(out, h("div", { class: "card", id: "assemble-syntax" }, h("h3", {}, "Not valid Python yet"),
        h("p", {}, `That order doesn't make valid Python${t.error.line ? ` (line ${t.error.line})` : ""} — an if needs its lines right under it.`)));
      return;
    }
    attempts += 1; R.rec.assembly_attempts = attempts;
    const res = await api("/api/checks", { problem_id: p.id, code });
    fill(out, h("div", { class: "card", id: "assemble-checks" }, h("h3", {}, "Checks"), checksList(res)));
    if (!res.all_pass) {
      stage({ speaker: "vesper", bubble: "Not yet — which block showed what happens in this order?" });
      if (attempts >= 3 && !document.getElementById("assemble-show")) out.append(h("div", { class: "row mt" }, h("button", { class: "btn ghost", id: "assemble-show", onclick: () => {
        (asm.answer || []).forEach((id, k) => { placed[k] = id; }); picked = null; R.rec.assembly_shown = true; R.rec.hints_used = Math.max(R.rec.hints_used, 3); render();
      } }, "Show me the order")));
      return;
    }
    R.workingCode = code; R.rec.fix_code = code; R.rec.fix_passed = true;
    stage({ speaker: "vesper", bubble: "Every check matches. Now trace what you built." });
    out.append(h("div", { class: "row mt" }, h("button", { class: "btn", id: "assemble-trace", onclick: () => {
      const cps = p.checkpoints.filter((c) => c.phase === "fixed");
      predictSequence({
        code, data: p.data, checkpoints: cps, phase: "assembled", intro: "Your assembly, this data. Trace it in your head first.",
        choices: { problem_id: p.id, phase: "fixed", code, data: flowData(p) },
        onDone: async (preds) => {
          const ev = await api("/api/evaluate", { problem_id: p.id, phase: "fixed", code, data: flowData(p), predictions: preds });
          beatExecute({ code, data: p.data, cps, preds, ev, phase: "assembled", onDone: beatReveal });
        },
      });
    } }, "Trace your assembly")));
  } }, "Run checks");
  const hintBtn = h("button", { class: "btn ghost", id: "assemble-hint", onclick: () => {
    const hs = asm.hints || []; if (hintsUsed >= hs.length) return;
    hintsBox.append(h("div", { class: "hint" }, hs[hintsUsed])); hintsUsed += 1;
    R.rec.hints_used = Math.max(R.rec.hints_used, hintsUsed); hintBtn.disabled = hintsUsed >= hs.length;
  } }, "Hint");
  show(dataCard(p.data, undefined, { compact: true }),
    h("div", { class: "card", id: "assemble-card" }, h("h3", {}, "Put it together"), skel, h("p", { class: "muted mt" }, "Your lines:"), tray,
      h("div", { class: "row mt" }, runBtn, hintBtn), hintsBox), out);
  render();
}

function beatReveal() {
  beat("reveal");
  const p = R.problem;
  const same = (R.workingCode || "").trim() === p.fix.recommended.trim();
  stage({ speaker: "vesper", bubble: same ? "That's exactly the recommended version — you built it." : "Here's the recommended version, next to yours." });
  show(h("div", { class: "card", id: "reveal-card" }, h("h3", {}, "Recommended — the simplest version"),
      h("p", { class: "muted" }, same ? "Line for line, what you assembled." : "Compare it with what you built."),
      codePanel(p.fix.recommended, { id: "recommended-code" }),
      (p.fix.alternatives || []).length ? h("details", { id: "alternatives", class: "mt" }, h("summary", {}, "Alternatives (also fine — not first choice)"),
        ...p.fix.alternatives.map((a) => h("div", { class: "mt" }, h("p", { class: "muted" }, a.note), a.code ? codePanel(a.code, { id: "" }) : null))) : null),
    h("div", { class: "row" }, h("button", { class: "btn", id: "to-verdict", onclick: beatVerdict }, "See the verdict")));
}

// ------------------------------------------------------------------ 11. SCHEDULE
async function beatSchedule() {
  beat("schedule");
  stopTimer();
  R.rec.minutes = Math.round((Date.now() - R.started) / 6000) / 10;
  const { record, item } = await api("/api/attempt", R.rec);
  const closed = item.closed;
  // Task 160 (slice A3, #4 S part): the one-liner already closed the verdict; the date shows once, here.
  stage({ speaker: "vesper", bubble: closed ? "Closed. That one's yours now." : "This one comes back cold." });
  show(h("p", { class: "muted", id: "next-recheck" }, closed ? `Closed ${item.closed_on}.` : `Comes back cold on ${item.next_recheck}.`),
    h("p", { class: "muted" }, `This round: ${VERDICTS[record.verdict][0]} · ${record.minutes} min`),
    h("div", { class: "row" }, h("button", { class: "btn", id: "go-home", onclick: home }, "Back to jobs")));
}

// ------------------------------------------------------------------ boot
$("#home-btn").addEventListener("click", home);
window.GOAT = { home, start, get round() { return R; } };
home();
