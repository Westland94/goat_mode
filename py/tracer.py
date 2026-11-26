"""GOAT Mode trace engine (runs in a subprocess, one run per call).

Reads JSON from stdin: {"code": str, "data": {name: value}}
Writes JSON to stdout: {"steps": [...], "stdout": str, "error": {...} | null}

Each step is one executed line of the problem's own code:
  {"line": n, "iteration": int | "after" | 0,
   "before": {var: repr}, "after": {var: repr},
   "stdout": printed-so-far, "error": {"type", "message"} | null}

A run that reaches MAX_STEPS stops itself and returns the partial trace with
"stopped": "step_limit" and a StepLimit error, so a never-ending loop still has steps to show.
The caller's 2-second kill is only the backstop for code that stalls without stepping.
"""
import ast
import io
import json
import re
import sys

FILENAME = "<goat>"
MAX_STEPS = 2000  # a run that reaches this many steps stops itself and returns what it has


class StepLimit(BaseException):
    """Raised from the trace function at MAX_STEPS. BaseException, so user code's
    `except Exception` can't swallow it."""


_ADDRESS = re.compile(r" at 0x[0-9a-fA-F]+(?=>$)")


def show(value):
    """repr(value), minus the memory address an angle-bracket object repr carries (Task 129):
    `<function is_bad at 0x10a9c4dc0>` -> `<function is_bad>`. Addresses change every run and mean
    nothing to the learner. String reprs are quoted, so they never start with '<' and stay as they are."""
    text = repr(value)
    if text.startswith("<") and text.endswith(">"):
        text = _ADDRESS.sub("", text)
    return text


def snapshot(frame):
    out = {}
    for name, value in frame.f_globals.items():
        if name.startswith("__") or callable(value) or type(value).__name__ == "module":
            continue
        try:
            out[name] = show(value)
        except Exception:  # pragma: no cover - exotic reprs
            out[name] = "<unprintable>"
    if frame.f_locals is not frame.f_globals:
        for name, value in frame.f_locals.items():
            if not name.startswith("__"):
                out[name] = show(value)
    return out


def _depth(frame):
    """How many of the problem's own frames sit above this one (0 = module level)."""
    d, f = 0, frame.f_back
    while f is not None:
        if f.f_code.co_filename == FILENAME:
            d += 1
        f = f.f_back
    return d


def top_loops(tree):
    """The first loop (breadth-first) and its sibling loops in the same block, in line order.

    Each one gets its own iteration counter. Loops nested inside a loop body are not listed:
    their lines sit inside the outer loop's body range and follow the outer loop's count.
    """
    first = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.While)):
            first = node
            break
    if first is None:
        return []
    siblings = [first]
    for node in ast.walk(tree):
        for field in ("body", "orelse", "finalbody"):
            block = getattr(node, field, None)
            if isinstance(block, list) and first in block:
                siblings = [n for n in block if isinstance(n, (ast.For, ast.While))]
    return [(n.lineno, n.body[0].lineno, n.end_lineno) for n in sorted(siblings, key=lambda n: n.lineno)]


def label_iterations(steps, loops):
    """Label each step with the loop iteration it runs in: 0 before any loop, 1..N, "after".

    Every top-level loop keeps its own counter, so the second loop of a count-then-scan
    program is numbered 1, 2, … too. Steps at the loops' own call depth (or shallower) are
    labelled by which loop's header/body their line sits in. Steps in deeper frames — e.g. a
    function called from inside a loop body — inherit the current label, so add()'s lines
    during iteration 2 say 2, not "after".
    """
    if not loops:
        for s in steps:
            s["iteration"] = 0
        return
    counts = [0] * len(loops)
    seen_loop = False
    loop_depth = None   # call depth the loops run at, learned from the first header step
    current = 0         # the label right now, inherited by deeper frames
    for i, s in enumerate(steps):
        line = s["line"]
        depth = s.get("_depth", 0)
        nxt = steps[i + 1]["line"] if i + 1 < len(steps) else None
        if loop_depth is not None and depth > loop_depth:
            s["iteration"] = current
            continue
        header_of = next((k for k, (h, _, _) in enumerate(loops) if line == h), None)
        body_of = next((k for k, (h, b0, b1) in enumerate(loops) if b0 <= line <= b1), None)
        if header_of is not None:
            k = header_of
            _, body_start, body_end = loops[k]
            seen_loop = True
            if loop_depth is None:
                loop_depth = depth
            if nxt is not None and body_start <= nxt <= body_end:
                counts[k] += 1
                s["iteration"] = counts[k]
            elif s.get("error") and nxt is None:
                s["iteration"] = counts[k] + 1  # crashed while fetching the next item
            else:
                s["iteration"] = "after"
        elif body_of is not None:
            s["iteration"] = counts[body_of]
        else:
            s["iteration"] = "after" if seen_loop else 0
        if loop_depth is not None and depth == loop_depth:
            current = s["iteration"]


def run_one(req):
    """Trace one piece of code. Returns the result dict (never raises for user-code errors)."""
    code = req["code"]
    real_stdout = sys.stdout
    captured = io.StringIO()

    try:
        compiled = compile(code, FILENAME, "exec")
        tree = ast.parse(code)
    except SyntaxError as e:
        return {"steps": [], "stdout": "", "error": {
            "type": "SyntaxError", "message": e.msg, "line": e.lineno}}

    steps = []
    pending = {"step": None}
    state = {"recording": True}

    def finish(frame):
        step = pending["step"]
        if step is not None:
            step["after"] = snapshot(frame)
            step["stdout"] = captured.getvalue()
            pending["step"] = None

    def local_trace(frame, event, arg):
        if not state["recording"]:
            return None
        if event == "line":
            finish(frame)
            if len(steps) >= MAX_STEPS:
                state["recording"] = False
                raise StepLimit()
            step = {"line": frame.f_lineno, "before": snapshot(frame), "error": None, "_depth": _depth(frame)}
            steps.append(step)
            pending["step"] = step
        elif event == "exception":
            exc_type, exc_value, _ = arg
            if pending["step"] is not None:
                pending["step"]["error"] = {"type": exc_type.__name__, "message": str(exc_value)}
        elif event == "return":
            finish(frame)
        return local_trace

    def global_trace(frame, event, arg):
        if frame.f_code.co_filename == FILENAME:
            return local_trace
        return None

    env = {"__name__": "__goat__"}
    env.update(req.get("data") or {})
    error = None
    sys.stdout = captured
    sys.settrace(global_trace)
    try:
        exec(compiled, env)
    except StepLimit:
        error = {"type": "StepLimit",
                 "message": f"Stopped after {MAX_STEPS} steps — the loop never ended.",
                 "line": steps[-1]["line"] if steps else None}
    except Exception as e:  # the user's code raised; that's data, not a crash
        tb = e.__traceback__
        line = None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == FILENAME:
                line = tb.tb_lineno
            tb = tb.tb_next
        error = {"type": type(e).__name__, "message": str(e), "line": line}
    finally:
        sys.settrace(None)
        sys.stdout = real_stdout

    # an exception can leave the last step unfinished
    if pending["step"] is not None:
        last = pending["step"]
        last["after"] = dict(last["before"])
        last["stdout"] = captured.getvalue()
        if error and not last["error"]:
            last["error"] = {"type": error["type"], "message": error["message"]}
    # only the step that actually raised keeps the error (handled exceptions clear)
    if error is None:
        for s in steps:
            s["error"] = None
    else:
        for s in steps[:-1]:
            s["error"] = None

    if error and error["type"] == "StepLimit" and steps:
        steps[-1]["error"] = {"type": "StepLimit", "message": error["message"]}

    label_iterations(steps, top_loops(tree))
    for s in steps:
        s.pop("_depth", None)
    return {"steps": steps, "stdout": captured.getvalue(), "error": error,
            "truncated": not state["recording"],
            "stopped": "step_limit" if error and error["type"] == "StepLimit" else None}


def main():
    if "--serve" in sys.argv:
        # batch mode (used by the harness): one JSON request per line in, one JSON result per line out.
        # The parent enforces the 2s limit per request and replaces this process if one runs over.
        out = sys.stdout
        out.write('{"ready": true}\n'); out.flush()
        for line in sys.stdin:
            if not line.strip():
                continue
            result = run_one(json.loads(line))
            sys.stdout = out
            out.write(json.dumps(result) + "\n"); out.flush()
        return
    json.dump(run_one(json.loads(sys.stdin.read())), sys.stdout)


if __name__ == "__main__":
    main()
