"""Port P3 (Task 184): the 12 /api routes, ported from app/server.py's handlers (server.py:91-237) to a
pure function the Web Worker calls. engine.py / tracer.py / stage_emitter.py / stage_check.py are imported
UNCHANGED. The only adaptation: engine.run_trace is rebound to call tracer.run_one in-process (PORT-PLAN
D1/D2) — no subprocess, no wall-clock kill (D3 is the shim's job, P4); the in-process 2000-step limit stays.
Progress and today come in with each call (D7/D11) and changed progress goes back out — no file I/O.
/api/intro_seen never reaches here: the worker answers it in JS (PORT-PLAN §5, route 10)."""
import copy
import datetime as dt
import json
import sys

sys.path.insert(0, "/app")
import engine          # noqa: E402
import tracer          # noqa: E402
import stage_check     # noqa: E402
import stage_emitter   # noqa: E402


_FORCE_TIMEOUT = False  # Task 189: set only while answering the shim's __timeout route
SCRATCH_MAX_STEPS = 1000  # Scratch S6: the Scratch Pad's step cap (route /api/scratch-trace)
SCRATCH_RECURSION_LIMIT = 360  # Scratch S13: recursion limit during a scratch run (restored after). 360 → ~352 frames deep: a 1-step-per-call runaway raises RecursionError at ~352 steps, while a 3-step-per-call walk (132's no-seen draft) still meets the 1,000-step cap first (S12 behaviour kept)


def _index_users(code, structure):
    """Scratch S10: SCRATCHPAD-POINTERS.md Rule 1(c), static — every Name inside the subscript of `structure[...]`
    (an index or a slice bound), over the whole program. The same AST walk as fesp02/pointers.py index_users."""
    import ast
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == structure:
            names |= {n.id for n in ast.walk(node.slice) if isinstance(n, ast.Name)}
    return sorted(names)


STACK_KEEP = 60   # Scratch S13: frames kept per step (innermost first); the page shows 50 and folds the rest
_orig_depth = None


def _stack_recorder():
    """Scratch S13: record the call stack at every step of ONE scratch run, with no change to tracer.py.

    tracer.run_one makes each step as {"line", "before", ..., "_depth": _depth(frame)} — _depth is looked up on the
    module at call time, exactly once per step, with the frame the step runs in. Wrapping it for this run gives the
    frame chain at the moment each step starts: stacks[i] belongs to steps[i] (the innermost STACK_KEEP frames +
    the true depth). sys.setprofile (independent of the tracer's settrace) adds the RETURNS: a function returning
    after step i is filed under i, innermost first, with its return value (or as unwound by an error)."""
    global _orig_depth
    stacks, returns = [], {}
    _orig_depth = tracer._depth

    def frame_info(f):
        code = f.f_code
        args = code.co_varnames[:code.co_argcount + code.co_kwonlyargcount]
        shown = []
        for a in args:
            if a in f.f_locals:
                try:
                    shown.append([a, tracer.show(f.f_locals[a])[:40]])
                except Exception:
                    shown.append([a, "?"])
        return {"fn": code.co_name, "line": f.f_lineno, "args": shown}

    def wrapped(frame):
        chain, f = [], frame
        while f is not None:
            if f.f_code.co_filename == tracer.FILENAME:
                chain.append(f)
            f = f.f_back
        stacks.append({"depth": len(chain), "frames": [frame_info(x) for x in chain[:STACK_KEEP]]})
        return _orig_depth(frame)

    def prof(frame, event, arg):
        if event == "return" and frame.f_code.co_filename == tracer.FILENAME and frame.f_code.co_name != "<module>" and stacks:
            lst = returns.setdefault(len(stacks) - 1, [])
            if len(lst) < STACK_KEEP:
                lst.append({"fn": frame.f_code.co_name, "args": frame_info(frame)["args"], "value": tracer.show(arg)[:40]})

    tracer._depth = wrapped
    sys.setprofile(prof)
    return stacks, returns


def _stack_recorder_off():
    sys.setprofile(None)
    if _orig_depth is not None:
        tracer._depth = _orig_depth


def _walk_roles(code, structure):
    """Scratch S12, static: what the graph device needs besides _index_users.
    loop_users — For-loop target names whose iterable contains `structure[...]` (`for nxt in graph[node]`,
                 `for nxt in sorted(graph[node])`): the neighbour being considered.
    entry_lines — the first body line of every function: a step there is a call ARRIVING at a node (a step
                 elsewhere that changes the current node is a return, i.e. backtracking, not a visit)."""
    import ast
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return {"loop_users": [], "entry_lines": []}
    loops, entries = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.AsyncFor)) and isinstance(node.target, ast.Name):
            if any(isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and n.value.id == structure for n in ast.walk(node.iter)):
                loops.add(node.target.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            entries.add(node.body[0].lineno)
    return {"loop_users": sorted(loops), "entry_lines": sorted(entries)}


def _run_trace(code, data=None, session=None):
    if _FORCE_TIMEOUT:  # the server's per-trace timeout result (engine.py:145-146, as TraceSession.run returns it)
        return json.loads(json.dumps(engine._TIMEOUT_RESULT))
    # what the server's subprocess path returns (engine.py:213-232), minus the process.
    # Task 188: the subprocess always ran on a serialized COPY of data, so user code that mutates its input
    # (nums.sort(), letters.reverse()) never touched the caller's dicts. In-process it would: the checks
    # route echoes c["input"] back and /api/choices traces two programs on the same data — so copy here.
    result = json.loads(json.dumps(tracer.run_one({"code": code, "data": copy.deepcopy(data or {})})))
    result["timeout"] = False
    return result


engine.run_trace = _run_trace  # stage_emitter and run_checks look it up on the module at call time


def _default_progress(p):
    return p if isinstance(p, dict) else {"attempts": [], "items": {}}  # server.py load_progress default


def _home(prog, today):
    problems = engine.load_problems()
    due = engine.due_today(prog, today)
    cards = [dict(item, problem_id=pid, one_liner=problems[pid]["one_liner"])
             for pid, item in prog.get("items", {}).items() if pid in problems]
    last = {}
    for pos, a in enumerate(prog.get("attempts", [])):
        if isinstance(a, dict) and a.get("problem_id"):
            last[a["problem_id"]] = (str(a.get("date") or ""), pos)
    cards.sort(key=lambda c: last.get(c["problem_id"], ("", -1)), reverse=True)
    return {"today": today.isoformat(), "due": due,
            "problems": [{"id": p["id"], "title": p["title"], "skill": p["skill"],
                          "section": p.get("section", "house"), "lc": p.get("lc")} for p in problems.values()],
            "items": cards, "intro_seen": prog.get("intro_seen", [])}


def _post(route, body, prog, today):
    if route == "/api/evaluate":
        p = engine.get_problem(body["problem_id"])
        cps = body.get("checkpoints") or [c for c in p["checkpoints"] if c["phase"] == body["phase"]]
        t = _run_trace(body["code"], body["data"])
        preds = body.get("predictions", {})
        return 200, {"trace": t, "results": [engine.evaluate_checkpoint(cp, t, preds.get(cp["id"])) for cp in cps]}, None
    if route == "/api/choices":
        p = engine.get_problem(body["problem_id"])
        phase = body["phase"]
        cps = body.get("checkpoints") or (
            [p["follow_up"]["checkpoint"]] if phase == "follow_up" else [c for c in p["checkpoints"] if c["phase"] == phase])
        other_code = p["fix"]["recommended"] if phase == "draft" else p["draft_code"]
        own, other = _run_trace(body["code"], body["data"]), _run_trace(other_code, body["data"])
        choices, missing = {}, []
        for cp in cps:
            if cp.get("kind") != "value":
                continue
            ch = engine.choice_options(p, cp, own, other)
            if ch is None:
                missing.append(cp["id"])
            else:
                choices[cp["id"]] = ch["options"]
        return 200, {"choices": choices, "missing": missing}, None
    if route == "/api/plan-options":
        p = engine.get_problem(body["problem_id"])
        return 200, {"options": engine.plan_options(p, list(engine.load_problems().values()))}, None
    if route == "/api/stage-stream":
        p = engine.get_problem(body["problem_id"])
        run = body.get("run") or "fix"
        try:
            events = stage_emitter.emit_stream_for_code(p, body["code"], body.get("data"), run)
        except ValueError as e:
            return 400, {"error": str(e)}, None
        graph = (p.get("stage") or {}).get("device") == "graph"
        return 200, {"contract": "stage-v2" if graph else "stage-v1", "streams": {run: events},
                     "stageable": stage_check.check_stream(events) is None and stage_check.stage_warning(events) is None,
                     "nodes": sum(1 for e in events if e["type"] == "node_add"), "events": len(events),
                     "positions": (p.get("stage") or {}).get("positions")}, None
    if route == "/api/complexity":
        race = engine.complexity_race(body["problem_id"], runner=_run_trace)
        race["sample_data"] = engine.COMPLEXITY_BUILDERS[body["problem_id"]](race["sizes"][-1])
        return 200, race, None
    if route == "/api/trace":
        return 200, _run_trace(body["code"], body.get("data")), None
    if route == "/api/scratch-trace":
        # Scratch S6: the same in-process tracer, at the Scratch Pad's tighter step cap (SCRATCHPAD-PLAN safety
        # rails: 1,000, not the lessons' 2,000). tracer.run_one reads MAX_STEPS at call time, so swap it for this
        # one run and always restore it — lesson routes keep 2,000. No second runner.
        saved = tracer.MAX_STEPS
        tracer.MAX_STEPS = SCRATCH_MAX_STEPS
        stacks, returns = _stack_recorder()   # S13: the call stack per step, without touching tracer.py
        # S13: a lower recursion limit for scratch runs only, so runaway recursion raises RecursionError (the frozen
        # stack + card) well inside the 1,000-step cap — at ~1 step per call, Python's default 1,000 would race it.
        saved_limit = sys.getrecursionlimit()
        sys.setrecursionlimit(SCRATCH_RECURSION_LIMIT)
        try:
            result = _run_trace(body["code"], body.get("data"))
        finally:
            sys.setrecursionlimit(saved_limit)
            tracer.MAX_STEPS = saved
            _stack_recorder_off()
        if len(stacks) == len(result.get("steps") or []):
            result["stacks"] = stacks
            result["returns"] = {str(k): v for k, v in returns.items()}
        if body.get("structure"):   # S10: Rule 1(c)'s static index users for the page's pointer inference
            result["index_users"] = _index_users(body["code"], body["structure"])
            result.update(_walk_roles(body["code"], body["structure"]))   # S12: graph walk roles
        return 200, result, None
    if route == "/api/checks":
        p = engine.get_problem(body["problem_id"])
        return 200, engine.run_checks(body["code"], body.get("checks") or p["checks"]), None
    if route == "/api/verdict":
        return 200, {"verdict": engine.verdict_for(body)}, None
    if route == "/api/attempt":
        record, item = engine.record_attempt(prog, body, today)
        return 200, {"record": record, "item": item}, prog
    return 404, {"error": "not found"}, None


def handle(req_json):
    """{route, method, body, progress, today} (JSON) -> {status, json, progress?} (JSON).

    Task 189: route "__timeout" carries the ORIGINAL {route, method, body} of a call the shim's 2 s clock
    (D3) cut off. It is answered by the normal handler with every trace returning _TIMEOUT_RESULT, so each
    route gets the server's own timed-out shape (evaluate: {trace, results: [... "never reached — ..."]};
    checks: {results: [... "stops with Timeout: ..."], all_pass: false}; trace: _TIMEOUT_RESULT itself)."""
    global _FORCE_TIMEOUT
    req = json.loads(req_json)
    if req.get("route") == "__timeout":
        inner = dict(req, **(req.get("body") or {}))
        _FORCE_TIMEOUT = True
        try:
            return handle(json.dumps(inner))
        finally:
            _FORCE_TIMEOUT = False
    route, method, body = req["route"], req.get("method", "GET"), req.get("body") or {}
    prog = _default_progress(req.get("progress"))
    today = dt.date.fromisoformat(req["today"])
    try:
        if method == "GET":
            if route == "/api/home":
                status, out, newp = 200, _home(prog, today), None
            elif route.startswith("/api/problem/"):
                status, out, newp = 200, engine.get_problem(route.rsplit("/", 1)[-1]), None
            else:
                status, out, newp = 404, {"error": "not found"}, None
        else:
            status, out, newp = _post(route, body, prog, today)
    except engine.ProblemError as e:
        status, out, newp = 404, {"error": str(e)}, None
    except Exception as e:  # the server's catch-all (server.py:150-151)
        status, out, newp = 500, {"error": f"{type(e).__name__}: {e}"}, None
    resp = {"status": status, "json": out}
    if newp is not None:
        resp["progress"] = newp
    return json.dumps(resp)
