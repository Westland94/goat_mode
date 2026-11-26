"""GOAT Mode engine: tracing, answer checking, verdicts and recheck scheduling.

Shared by server.py (and any later test harness). Pure Python stdlib.
"""
import ast
import datetime as dt
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TRACER = os.path.join(HERE, "tracer.py")
PROBLEMS_DIR = os.environ.get("GOAT_PROBLEMS", os.path.join(HERE, "problems"))
TIMEOUT_S = 2.0
LADDER_DAYS = [1, 3, 7]  # cold recheck intervals; a cold pass on the last step closes the item


# ---------------------------------------------------------------- problems

class ProblemError(Exception):
    """A problem that can't be served: not found, or its JSON is invalid."""


# PLAN §5 required fields. Dotted paths; "[]" means "for every item of this list".
REQUIRED = [
    "id", "skill", "title", "scenario", "data.name", "data.value", "model_restatement",
    "clarify", "clarify[].keywords", "clarify[].question", "clarify[].answer", "clarify_fallback",
    "blueprint", "draft_code",
    "checkpoints", "checkpoints[].id", "checkpoints[].phase", "checkpoints[].at",
    "checkpoints[].prompt", "checkpoints[].kind",
    "why_line", "fix.recommended", "fix.alternatives", "fix.hints",
    "checks", "checks[].input", "checks[].expected",
    "follow_up.prompt", "follow_up.data.name", "follow_up.data.value", "follow_up.checkpoint",
    "follow_up.recommended", "follow_up.fix_hint",
    "one_liner", "trace_watch",
]
_MISSING = object()


def _missing_paths(obj, path):
    """Return every concrete missing path for one dotted REQUIRED entry."""
    head, _, rest = path.partition(".")
    is_list = head.endswith("[]")
    key = head[:-2] if is_list else head
    if not isinstance(obj, dict) or obj.get(key, _MISSING) is _MISSING or obj.get(key) is None:
        return [key]
    val = obj[key]
    if is_list:
        if not isinstance(val, list):
            return [f"{key} (must be a list)"]
        out = []
        for i, item in enumerate(val):
            out += [f"{key}[{i}].{m}" for m in _missing_paths(item, rest)]
        return out
    if rest:
        return [f"{key}.{m}" for m in _missing_paths(val, rest)]
    return []


def validate_problem(p):
    """Return a list of human-readable problems with this problem's data (empty = valid)."""
    errors = []
    for path in REQUIRED:
        errors += [f"missing field '{m}'" for m in _missing_paths(p, path)]
    if "intro" not in p:
        errors.append("missing field 'intro'")
    elif not isinstance(p["intro"], dict):
        errors.append("missing field 'intro' (must be an object)")
    else:
        for path in ["job", "idea.rule", "idea.detail", "watch.code", "watch.data.name", "watch.data.value"]:
            errors += [f"missing field 'intro.{m}'" for m in _missing_paths(p["intro"], path)]
    if "explain" in p:
        ex = p["explain"] if isinstance(p["explain"], dict) else {}
        for f in ("checkpoint", "rule", "bridge"):
            if not ex.get(f):
                errors.append(f"missing field 'explain.{f}' (explain is optional, but needs {f} if present)")
        if "fix" in ex:
            fx = ex["fix"] if isinstance(ex["fix"], dict) else {}
            for path in ["rule", "walk", "walk[].line", "walk[].gloss", "contrast.wrong", "contrast.right"]:
                errors += [f"missing field 'explain.fix.{m}'" for m in _missing_paths(fx, path)]
            n_lines = len(((p.get("fix") or {}).get("recommended") or "").split("\n"))
            for i, w in enumerate(fx.get("walk") or []):
                if isinstance(w, dict) and isinstance(w.get("line"), int) and not 1 <= w["line"] <= n_lines:
                    errors.append(f"explain.fix.walk[{i}].line {w['line']} is outside fix.recommended (1–{n_lines})")
        ids = [c.get("id") for c in p.get("checkpoints") or [] if isinstance(c, dict)]
        if ex.get("checkpoint") and ex["checkpoint"] not in ids:
            errors.append(f"explain.checkpoint '{ex['checkpoint']}' names no checkpoint (have: {', '.join(map(str, ids))})")
    for i, cp in enumerate(p.get("checkpoints") or []):
        if not isinstance(cp, dict):
            continue
        if cp.get("kind") == "value" and cp.get("at") != "end" and not cp.get("var"):
            errors.append(f"missing field 'checkpoints[{i}].var' (needed for a value checkpoint)")
        if cp.get("kind") == "outcome":
            for j, ch in enumerate(cp.get("choices") or [None]):
                if not isinstance(ch, dict) or "label" not in ch or "match" not in ch:
                    errors.append(f"missing field 'checkpoints[{i}].choices[{j}].label/match'")
    return errors


def load_all():
    """Load every problems/*.json. Returns (valid problems by id, {filename: [errors]})."""
    problems, errors = {}, {}
    try:
        files = sorted(fn for fn in os.listdir(PROBLEMS_DIR) if fn.endswith(".json"))
    except OSError as e:
        return {}, {"problems/": [str(e)]}
    for fn in files:
        try:
            with open(os.path.join(PROBLEMS_DIR, fn)) as f:
                p = json.load(f)
        except ValueError as e:
            errors[fn] = [f"not valid JSON: {e}"]
            continue
        if not isinstance(p, dict):
            errors[fn] = ["top level must be a JSON object"]
            continue
        errs = validate_problem(p)
        if not errs and p["id"] in problems:
            errs = [f"duplicate id '{p['id']}'"]
        if errs:
            errors[fn] = errs
        else:
            problems[p["id"]] = p
    return problems, errors


def load_problems():
    return load_all()[0]


def get_problem(pid):
    """The one way to fetch a problem. Raises ProblemError with a plain message."""
    problems, errors = load_all()
    if pid in problems:
        return problems[pid]
    bad = [f"{fn}: {'; '.join(errs)}" for fn, errs in errors.items() if fn.startswith(f"{pid}-") or fn == f"{pid}.json"]
    if bad:
        raise ProblemError(f"Problem {pid} can't load — " + " | ".join(bad))
    raise ProblemError(f"Problem {pid} not found.")


# ---------------------------------------------------------------- tracing

_TIMEOUT_RESULT = {"steps": [], "stdout": "", "timeout": True, "error": {
    "type": "Timeout", "message": "Stopped after 2 seconds — probably a loop that never ends.", "line": None}}


class TraceSession:
    """One long-lived tracer process for many traces (the harness uses one per problem).

    Each request still gets its own 2-second limit, measured from when the request is sent
    to a worker that is already up — so a slow process start never counts against the code.
    A request that runs over gets a Timeout result, and the worker is replaced.
    """

    def __init__(self):
        self.proc = None

    def _start(self):
        import queue
        import threading
        self.proc = subprocess.Popen([sys.executable, "-I", TRACER, "--serve"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.lines = queue.Queue()
        proc, lines = self.proc, self.lines

        def pump():
            for line in proc.stdout:
                lines.put(line)
            lines.put(None)  # process ended
        threading.Thread(target=pump, daemon=True).start()
        first = self.lines.get(timeout=30)  # wait for "ready": startup time is not the code's time
        if not first or "ready" not in first:
            raise RuntimeError("tracer worker failed to start")

    def run(self, code, data=None):
        import queue
        if self.proc is None or self.proc.poll() is not None:
            self._start()
        self.proc.stdin.write(json.dumps({"code": code, "data": data or {}}) + "\n")
        self.proc.stdin.flush()
        try:
            line = self.lines.get(timeout=TIMEOUT_S)
        except queue.Empty:
            self.close()
            return json.loads(json.dumps(_TIMEOUT_RESULT))
        if line is None:
            self.close()
            return {"steps": [], "stdout": "", "timeout": False,
                    "error": {"type": "EngineError", "message": "tracer worker exited", "line": None}}
        result = json.loads(line)
        result["timeout"] = False
        return result

    def close(self):
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            self.proc = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def run_trace(code, data=None, session=None):
    """Run code with real CPython in a subprocess and return the line trace."""
    if session is not None:
        return session.run(code, data)
    payload = json.dumps({"code": code, "data": data or {}})
    try:
        proc = subprocess.run(
            [sys.executable, "-I", TRACER], input=payload,
            capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return json.loads(json.dumps(_TIMEOUT_RESULT))
    try:
        result = json.loads(proc.stdout)
    except ValueError:
        return {"steps": [], "stdout": "", "error": {
            "type": "EngineError", "message": (proc.stderr or "no output")[-500:], "line": None}}
    result["timeout"] = False
    return result


# ---------------------------------------------------------------- comparing values

def _literal(text):
    try:
        return True, ast.literal_eval(text.strip())
    except Exception:
        return False, None


def _squash(text):
    return "".join(text.replace('"', "'").split())


def strict_equal(a, b):
    """== that is type-aware for numbers: 3 != 3.0, True != 1, recursively inside containers."""
    if isinstance(a, (bool, int, float, complex)) or isinstance(b, (bool, int, float, complex)):
        return type(a) is type(b) and a == b
    if isinstance(a, (list, tuple)) or isinstance(b, (list, tuple)):
        return type(a) is type(b) and len(a) == len(b) and all(strict_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) or isinstance(b, dict):
        return (type(a) is type(b) and len(a) == len(b)
                and all(any(strict_equal(k, k2) and strict_equal(v, b[k2]) for k2 in b) for k, v in a.items()))
    if isinstance(a, (set, frozenset)) or isinstance(b, (set, frozenset)):
        return (type(a) is type(b) and len(a) == len(b)
                and all(any(strict_equal(x, y) for y in b) for x in a))
    return a == b


def same_value(answer, actual_repr, printed=False):
    """Equality between what Andrew typed and the real value (a repr, or printed text if printed=True).

    Numbers are type-aware (3 vs 3.0, True vs 1 differ). Lenient only about notation:
    typing ana for 'ana', and — for printed output, where quotes can't show — 'GOA' for GOA.
    """
    if answer is None:
        return False
    answer, actual_repr = str(answer).strip(), str(actual_repr).strip()
    ok_a, a = _literal(answer)
    ok_b, b = _literal(actual_repr)
    if printed and ok_a and isinstance(a, str) and a == actual_repr:
        return True  # print shows GOA for the string 'GOA'; the quotes are notation, not a divergence
    if ok_a and ok_b:
        return strict_equal(a, b)
    if ok_b and isinstance(b, str):  # typed ana for 'ana'
        return answer.strip("'\"") == b
    return _squash(answer) == _squash(actual_repr)


_FOREVER_WORDS = ("forever", "never end", "never ends", "never stop", "never stops", "never finish",
                  "infinite", "endless", "doesn't stop", "does not stop", "doesn't end", "does not end",
                  "keeps going", "keeps looping", "hangs", "step limit", "steplimit")


def _predicts_forever(prediction):
    """For a run stopped at the step limit: did Andrew predict a loop that never ends?"""
    text = str(prediction).lower().replace("’", "'")
    return any(w in text for w in _FOREVER_WORDS)


def _error_text(err):
    return f"{err['type']}: {err['message']}" if err else ""


# ---------------------------------------------------------------- complexity race (Task 133, slice 1)

# Growing-input builders, keyed by problem id — code, not JSON, for this slice (no input language).
# Each takes a size n and returns the run's data {name: value}.
COMPLEXITY_BUILDERS = {
    # Two Sum: no pair sums to 2n+1, so the draft and the fix both scan everything and print [].
    "140": lambda n: {"case": [list(range(1, n + 1)), 2 * n + 1]},
}


def complexity_race(problem_id, runner=None):
    """Run the problem's draft and fix on growing inputs and count their steps.

    Sizes come from the problem JSON's `complexity.sizes`; the input for each size from
    COMPLEXITY_BUILDERS. runner(code, data) traces one run (default run_trace; the server passes
    its warm-session tracer). Raises ProblemError — the server's 404 — for an unknown id, a problem
    with no `complexity` block, or no builder for it.
    """
    p = get_problem(problem_id)  # ProblemError if unknown
    sizes = (p.get("complexity") or {}).get("sizes")
    if not sizes or problem_id not in COMPLEXITY_BUILDERS:
        raise ProblemError(f"Problem {problem_id} has no complexity race.")
    runner = runner or run_trace
    build = COMPLEXITY_BUILDERS[problem_id]
    out = {"sizes": list(sizes), "draft_steps": [], "fix_steps": [], "draft_out": [], "fix_out": []}
    for n in sizes:
        for which, code in (("draft", p["draft_code"]), ("fix", p["fix"]["recommended"])):
            t = runner(code, build(n))
            out[f"{which}_steps"].append(len(t["steps"]))
            out[f"{which}_out"].append(t.get("stdout", "").strip())
            if t.get("error"):
                out.setdefault("errors", []).append({"size": n, "run": which, "type": t["error"]["type"]})
    return out


# ---------------------------------------------------------------- checkpoints

def find_step(trace, at):
    """The step a checkpoint's `at` addresses. Default: the first step matching {line, iteration}.
    With the optional `occurrence` (Task 132, 0-based): the Nth execution of that line, whatever its
    iteration label — so a 3rd+ recursive call (all labelled iteration 1) is addressable."""
    if "occurrence" in at:
        n = 0
        for i, s in enumerate(trace["steps"]):
            if s["line"] == at["line"]:
                if n == at["occurrence"]:
                    return i, s
                n += 1
        return None, None
    for i, s in enumerate(trace["steps"]):
        if s["line"] == at["line"] and s["iteration"] == at["iteration"]:
            return i, s
    return None, None


def choice_options(p, cp, phase_trace, other_trace):
    """Three tap-to-choose options for a kind=value checkpoint (Task 98), or None.

    The true option is what evaluate_checkpoint reveals on the checkpoint's own phase trace.
    The two wrong options are the first two distinct, non-empty strings from, in order:
    (a) the other phase's answer at the same coordinate; (b) the same var at neighbouring
    steps of both traces, nearest first; (c) every other var at the checkpoint step, both
    traces, name order; (d) every var at every other step, both traces, step then name order;
    (e) for at == "end", stdout-so-far at every step of both traces; (f) a numeric nudge of
    the true value. Shuffled deterministically by "<problem id>:<checkpoint id>".
    Outcome checkpoints have authored choices, so they return None.
    """
    import random
    if cp.get("kind") != "value":
        return None
    real = evaluate_checkpoint(cp, phase_trace, None)
    if not real.get("reached"):
        return None
    true = str(real["real"])
    wrong = []

    def offer(v):
        if len(wrong) < 2 and isinstance(v, str) and v.strip() and v != true and v not in wrong:
            wrong.append(v)

    traces = [phase_trace, other_trace]

    def anchor(t):
        steps = t["steps"]
        if not steps:
            return None
        if cp["at"] == "end":
            return len(steps) - 1
        idx, _ = find_step(t, cp["at"])
        if idx is None:  # not in this trace: anchor at the phase trace's index, clipped
            pidx = real.get("step_index") or 0
            idx = min(pidx, len(steps) - 1)
        return idx

    anchors = [anchor(t) for t in traces]
    # (a) the other phase's answer at the same coordinate
    other = evaluate_checkpoint(cp, other_trace, None)
    if other.get("reached"):
        offer(str(other["real"]))
    # (b) same var, neighbouring steps of both traces, nearest first
    var = cp.get("var")
    if var:
        reach = max(len(t["steps"]) for t in traces)
        for d in range(1, reach + 1):
            for t, a in zip(traces, anchors):
                if a is None:
                    continue
                for j in (a - d, a + d):
                    if 0 <= j < len(t["steps"]):
                        offer(t["steps"][j]["after"].get(var))
    # (c) every other var at the checkpoint step, both traces, name order
    for t, a in zip(traces, anchors):
        if a is not None:
            after = t["steps"][a]["after"]
            for name in sorted(after):
                if name != var:
                    offer(after[name])
    # (d) every var at every other step, both traces, step order then name order
    for t, a in zip(traces, anchors):
        for j, s in enumerate(t["steps"]):
            if j != a:
                for name in sorted(s["after"]):
                    offer(s["after"][name])
    # (e) end checkpoints: what had been printed by each step
    if cp["at"] == "end":
        for t in traces:
            for s in t["steps"]:
                offer((s.get("stdout") or "").strip())
    # (f) numeric nudge of the true value
    if len(wrong) < 2:
        try:
            val = ast.literal_eval(true)
        except Exception:
            val = None
        if isinstance(val, bool):
            offer(repr(not val))
        elif isinstance(val, (int, float)):
            unit = 1 if isinstance(val, int) else 1.0
            for k in range(1, 50):
                for sign in (1, -1):
                    offer(repr(val + sign * k * unit))
    if len(wrong) < 2:
        return None
    options = [true] + wrong
    random.Random(f"{p['id']}:{cp['id']}").shuffle(options)
    return {"options": options, "correct": options.index(true)}


def plan_options(p, bank):
    """Three restatements to pick from for the restate beat (Task 101): strings only.

    [model_restatement (the right job), blueprint (the draft's wrong plan), a sibling], where the
    sibling is the model_restatement of the next problem, cyclically by id, in the same skill group
    whose restatement differs from this problem's model and blueprint — else the next such problem
    in the whole bank. The right answer sits in slot (p's index in the id-sorted bank) % 3; the
    blueprint then the sibling fill the other slots in that order. No randomness.
    """
    bank = sorted(bank, key=lambda q: q["id"])
    ids = [q["id"] for q in bank]
    i = ids.index(p["id"])
    model, blueprint = p["model_restatement"], p["blueprint"]
    taken = {model.strip(), blueprint.strip()}

    def next_sibling(pool):
        order = sorted(pool, key=lambda q: q["id"])
        oids = [q["id"] for q in order]
        start = oids.index(p["id"]) if p["id"] in oids else -1
        for k in range(1, len(order) + 1):
            q = order[(start + k) % len(order)]
            if q["id"] != p["id"] and q["model_restatement"].strip() not in taken:
                return q["model_restatement"]
        return None

    sibling = next_sibling([q for q in bank if q["skill"] == p["skill"]]) or next_sibling(bank)
    slot = i % 3
    others = [blueprint, sibling]
    return [model if s == slot else others.pop(0) for s in range(3)]


def evaluate_checkpoint(cp, trace, prediction):
    """Compare one locked prediction against the real run. Returns the reveal record."""
    err = trace.get("error")
    res = {"id": cp["id"], "prediction": prediction, "reached": True,
           "line": None, "iteration": None, "step_index": None, "error": err}

    if cp["at"] == "end":
        res["step_index"] = len(trace["steps"]) - 1 if trace["steps"] else None
        printed = trace.get("stdout", "").strip()
        if err:
            res["real"] = (printed + "\n" if printed else "") + "stops with " + _error_text(err)
            res["line"] = err.get("line")
            res["correct"] = bool(prediction) and (
                err["type"].lower() in str(prediction).lower()
                or (err["type"] == "StepLimit" and _predicts_forever(prediction)))
        else:
            res["real"] = printed if printed else "(nothing printed)"
            res["correct"] = same_value(prediction, printed, printed=True) if printed else (
                str(prediction).strip().lower() in ("", "nothing", "(nothing printed)"))
        if trace["steps"]:
            last = trace["steps"][-1]
            res["line"] = res["line"] or last["line"]
            res["iteration"] = last["iteration"]
        return res

    idx, step = find_step(trace, cp["at"])
    res["line"], res["iteration"] = cp["at"]["line"], cp["at"]["iteration"]
    if step is None:
        stop = trace["steps"][-1]["line"] if trace["steps"] else None
        res.update(reached=False, correct=False,
                   real=f"never reached — the run stopped at line {stop}"
                   + (f" ({_error_text(err)})" if err else ""))
        return res
    res["step_index"] = idx

    if cp["kind"] == "value":
        var = cp["var"]
        real = step["after"].get(var, "(not defined yet)")
        if step.get("error"):
            res["real"] = f"{real} — then the line stops with {_error_text(step['error'])}"
            res["correct"] = same_value(prediction, real)
        else:
            res["real"] = real
            res["correct"] = same_value(prediction, real)
        return res

    # outcome: which of the authored choices actually happened?
    actual_idx = None
    for i, ch in enumerate(cp["choices"]):
        m = ch["match"]
        if m.get("error") and step.get("error"):
            actual_idx = i
        elif not step.get("error"):
            if "var" in m and same_value(m["value"], step["after"].get(m["var"], "")):
                actual_idx = i
            elif m.get("unchanged") and step["before"] == step["after"]:
                actual_idx = i
        if actual_idx is not None:
            break
    chosen = prediction.get("choice") if isinstance(prediction, dict) else None
    label = cp["choices"][actual_idx]["label"] if actual_idx is not None else "something else"
    if step.get("error"):
        label = f"{label}: {_error_text(step['error'])}"
    elif actual_idx is None:
        label = f"something else — counts is {step['after'].get(cp['choices'][0]['match'].get('var', ''), '?')}"
    res["real"] = label
    res["actual_choice"] = actual_idx
    res["correct"] = chosen is not None and chosen == actual_idx
    return res


def evaluate(code, data, checkpoints, predictions):
    trace = run_trace(code, data)
    results = [evaluate_checkpoint(cp, trace, predictions.get(cp["id"])) for cp in checkpoints]
    return {"trace": trace, "results": results}


# ---------------------------------------------------------------- checks (does the code do what we meant?)

def run_checks(code, checks, session=None):
    out = []
    for c in checks:
        t = run_trace(code, c["input"], session=session)
        got = t.get("stdout", "").strip()
        if t.get("error"):
            got_text = (got + "\n" if got else "") + "stops with " + _error_text(t["error"])
            passed = False
        else:
            got_text = got if got else "(nothing printed)"
            passed = same_value(got, c["expected"])
        out.append({"input": c["input"], "expected": c["expected"], "got": got_text, "pass": passed})
    return {"results": out, "all_pass": all(r["pass"] for r in out)}


def expected_output(code, data):
    t = run_trace(code, data)
    return t.get("stdout", "").strip(), t.get("error")


# ---------------------------------------------------------------- verdicts & scheduling

def verdict_for(record):
    """clean | found | helped (teaching)   cold_pass | cold_helped | cold_not_yet (cold)."""
    hints = record.get("hints_used", 0)
    preds = record.get("predictions", [])
    misses = sum(1 for p in preds if not p.get("correct"))
    if record.get("mode") == "cold":
        if not record.get("fix_passed"):
            return "cold_not_yet"
        if hints > 0:
            return "cold_helped"
        if misses:
            return "cold_not_yet"  # it works, but he couldn't run his own code in his head yet
        return "cold_pass"
    if hints >= 2:
        return "helped"
    if misses == 0 and hints == 0:
        return "clean"
    return "found"


def schedule(item, verdict, today):
    """Mutates and returns the per-problem schedule item."""
    item = dict(item or {"ladder": None, "next_recheck": None, "closed": False, "closed_on": None})
    if verdict in ("clean",):
        item["ladder"] = 1
    elif verdict in ("found", "helped", "cold_not_yet", "cold_helped"):
        item["ladder"] = 0
    elif verdict == "cold_pass":
        step = item.get("ladder")
        if step is not None and step >= len(LADDER_DAYS) - 1:
            item["closed"] = True
            item["closed_on"] = today.isoformat()
            item["next_recheck"] = None
            item["last_verdict"] = verdict
            return item
        item["ladder"] = 0 if step is None else step + 1
    item["next_recheck"] = (today + dt.timedelta(days=LADDER_DAYS[item["ladder"]])).isoformat()
    item["last_verdict"] = verdict
    return item


def record_attempt(progress, record, today=None):
    today = today or dt.date.today()
    record = dict(record)
    record["date"] = today.isoformat()
    record["verdict"] = verdict_for(record)
    pid = record["problem_id"]
    items = progress.setdefault("items", {})
    items[pid] = schedule(items.get(pid), record["verdict"], today)
    record["next_recheck"] = items[pid]["next_recheck"]
    progress.setdefault("attempts", []).append(record)
    return record, items[pid]


def due_today(progress, today=None):
    today = (today or dt.date.today()).isoformat()
    return sorted(pid for pid, it in progress.get("items", {}).items()
                  if not it.get("closed") and it.get("next_recheck") and it["next_recheck"] <= today)
