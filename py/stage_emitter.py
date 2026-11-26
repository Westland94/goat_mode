"""Stage emitter: turn a computed trace into a stage-v1 event stream (see stage_contract.md).

Run:  python3 app/stage_emitter.py <problem id>
Prints {"contract": "stage-v1", "streams": {"draft": [...], "fix": [...]}}.

emit_stream(problem, run) runs the draft ("draft") or fix ("fix") code through the real
tracer and reads the steps device by device, following the contract's Sources table:
  * a new loop pass            -> gauge_step on the pass counter, then actor_arrive for the
                                  loop variable's new value (heading for its jar if a dict
                                  is on stage)
  * a dict gaining a key       -> container_appear (jar); a key's value changing -> container_add
  * a list (not the input)     -> container_appear (tray) when it first holds items; growing ->
                                  container_add
  * an element vanishing from a jar or tray (replaced or removed) -> item_discard first
  * the run's error            -> error_flash (+ the why caption); clean end -> final caption
No problem-specific data lives here: every name, label and value comes from the trace.
"""
import ast
import json
import sys

import engine


def _lit(text):
    """The Python value behind a trace repr, or None if it isn't a plain literal."""
    try:
        return True, ast.literal_eval(text)
    except Exception:
        return False, None


def _shown(v):
    """Display form of a value: strings bare, everything else as its repr."""
    return v if isinstance(v, str) else repr(v)


def _gone(old, new):
    """Elements present in old but missing from new (multiset, in old's order)."""
    if not isinstance(old, list):
        return []
    left = list(new) if isinstance(new, list) else []
    out = []
    for x in old:
        if x in left:
            left.remove(x)
        else:
            out.append(x)
    return out


def _added(old, new):
    """Display form of what landed: the numeric step (+n) or the new last element."""
    if isinstance(new, (int, float)) and not isinstance(new, bool):
        base = old if isinstance(old, (int, float)) and not isinstance(old, bool) else 0
        d = new - base
        return f"+{d}" if d >= 0 else str(d)
    if isinstance(new, list) and new:
        return _shown(new[-1])
    return None


def emit_stream(problem, run):
    code = problem["draft_code"] if run == "draft" else problem["fix"]["recommended"]
    data_name, data_value = problem["data"]["name"], problem["data"]["value"]
    trace = engine.run_trace(code, {data_name: data_value})

    ev = [{"type": "scene_open", "title": problem["title"], "job": problem["scenario"]}]
    ev.append({"type": "caption", "role": "draft", "text": problem["blueprint"]} if run == "draft"
              else {"type": "caption", "role": "fix", "text": problem["explain"]["fix"]["rule"]})

    stage = problem.get("stage") or {}
    if stage.get("device") == "graph":
        return ev + _graph_events(stage, trace, problem, run)

    total = len(data_value) if isinstance(data_value, (list, str, dict)) else None
    prev_state = {}          # var -> literal value at the previous step
    seen_iters = set()
    last_actor = None
    dict_vars = []           # dict variables on stage, in order of appearance
    trays = set()            # tray ids already drawn

    def jar_id(var, key):
        return f"jar:{_shown(key)}" if len(dict_vars) <= 1 else f"jar:{var}.{_shown(key)}"

    for step in trace["steps"]:
        state = {}
        for var, rep in step["after"].items():
            ok, val = _lit(rep)
            if ok and var != data_name:
                state[var] = val
        for var, val in state.items():
            if isinstance(val, dict) and var not in dict_vars:
                dict_vars.append(var)

        it = step["iteration"]
        if isinstance(it, int) and it >= 1 and it not in seen_iters:
            seen_iters.add(it)
            changed = [v for v in state if v not in prev_state or prev_state[v] != state[v]]
            loop_var = next((v for v in changed if not isinstance(state[v], (dict, list))), None)
            if loop_var is not None:
                g = {"type": "gauge_step", "id": f"gauge:{loop_var}", "value": it}
                if total is not None:
                    g["max"] = total
                g["label"] = loop_var
                ev.append(g)
                label = _shown(state[loop_var])
                last_actor = f"actor:{loop_var}{it}"
                a = {"type": "actor_arrive", "actor": last_actor, "label": label}
                if dict_vars:
                    a["to"] = jar_id(dict_vars[0], state[loop_var])
                ev.append(a)

        for var, val in state.items():
            old = prev_state.get(var)
            if isinstance(val, dict):
                old = old if isinstance(old, dict) else {}
                for k, v in val.items():
                    jid = jar_id(var, k)
                    if k not in old:
                        ev.append({"type": "container_appear", "id": jid, "kind": "jar", "label": _shown(k)})
                    if k in old and old[k] == v:
                        continue
                    for x in _gone(old.get(k), v):
                        ev.append({"type": "item_discard", "id": jid, "item": _shown(x), "note": "thrown away"})
                    num = isinstance(v, (int, float)) and not isinstance(v, bool)
                    add = {"type": "container_add", "id": jid}
                    item = _added(old.get(k), v)
                    if item is not None:
                        add["item"] = item
                    add["value"] = v if num else _shown(v)
                    ev.append(add)
            elif isinstance(val, list):
                tid = f"tray:{var}"
                was = old if isinstance(old, list) else []
                if val == was:
                    continue
                if tid not in trays and val:
                    trays.add(tid)
                    ev.append({"type": "container_appear", "id": tid, "kind": "tray", "label": var})
                for x in _gone(was, val):
                    ev.append({"type": "item_discard", "id": tid, "item": _shown(x), "note": "thrown away"})
                if val:
                    ev.append({"type": "container_add", "id": tid, "item": _shown(val[-1]), "value": repr(val)})
        prev_state = state

    err = trace.get("error")
    if err:
        flash = {"type": "error_flash", "text": f"{err['type']}: {err['message']}"}
        if last_actor:
            flash["at"] = last_actor
        ev.append(flash)
        if run == "draft":
            ev.append({"type": "caption", "role": "why", "text": problem["why_line"]})
    else:
        ev.append({"type": "caption", "role": "final", "text": trace["stdout"].strip()})
        if run == "draft":
            ev.append({"type": "caption", "role": "why", "text": problem["why_line"]})
    ev.append({"type": "scene_close"})
    return ev


def emit_stream_for_code(problem, code, data=None, run="fix"):
    """The stage stream for the LEARNER's code (Task 120): his code, traced for real.

    data: {name: value} with one variable (default: the problem's own data). run picks only the
    opening caption and whether the why-line is appended (run == "draft"), exactly as emit_stream.
    The envelope is emit_stream's own: the problem is copied with his code and data in place of the
    authored ones, so graph problems get _graph_events and the rest the same v1 stream.
    """
    if data is None:
        data = {problem["data"]["name"]: problem["data"]["value"]}
    if not isinstance(data, dict) or len(data) != 1:
        raise ValueError("data must be an object holding exactly one variable")
    (name, value), = data.items()
    mine = dict(problem, draft_code=code, fix=dict(problem["fix"], recommended=code),
                data=dict(problem["data"], name=name, value=value))
    return emit_stream(mine, run)


GRAPH_REPEAT_CAP = 4  # a node becoming current for the 4th time = the walk is looping; stop staging there


def _val(rep):
    """A trace repr as a Python value (set() included), or None."""
    if rep == "set()":
        return set()
    ok, v = _lit(rep)
    return v if ok else None


def _graph_events(stage, trace, problem, run):
    """v2 graph device (Task 117): the map from the graph variable, then the walk from the trace.

    stage names trace variables: graph (the adjacency dict), current (the node being visited),
    seen (the visited set), candidate (the neighbour being considered), target (the goal node).
    """
    m = stage["map"]
    nid = lambda n: f"node:{_shown(n)}"
    ev, built = [], False
    nodes = set()
    prev_cur, cur_count, seen_prev = None, {}, set()
    pending_skip = None          # (from, to): a seen candidate the walk may pass over
    skipped, found, capped = set(), False, False
    for step in trace["steps"]:
        after = step["after"]
        g = _val(after[stage["graph"]]) if stage["graph"] in after else None
        if not built and isinstance(g, dict):
            built = True
            def add(n):  # a node is added the first time anything names it
                if n not in nodes:
                    nodes.add(n)
                    ev.append({"type": "node_add", "map": m, "id": nid(n), "label": _shown(n)})
            for a, outs in g.items():   # first-seen order: each edge right after its endpoints
                add(a)
                for b in outs:
                    add(b)
                    ev.append({"type": "edge_add", "map": m, "from": nid(a), "to": nid(b)})
        if not built or found or capped:
            continue
        cur = _val(after[stage["current"]]) if stage.get("current") in after else None
        seen = _val(after[stage["seen"]]) if stage.get("seen") in after else None
        cand = _val(after[stage["candidate"]]) if stage.get("candidate") in after else None
        target = _val(after[stage["target"]]) if stage.get("target") in after else None
        if cur is not None and cur != prev_cur and cur in nodes:
            if pending_skip and pending_skip[1] != cur and pending_skip not in skipped:
                skipped.add(pending_skip)
                ev.append({"type": "edge_skip", "map": m, "from": nid(pending_skip[0]), "to": nid(pending_skip[1])})
            pending_skip = None
            prev_cur = cur
            cur_count[cur] = cur_count.get(cur, 0) + 1
            ev.append({"type": "node_current", "map": m, "id": nid(cur)})
            if target is not None and cur == target:
                ev.append({"type": "node_found", "map": m, "id": nid(cur)})
                found = True
                continue
            if cur_count[cur] >= GRAPH_REPEAT_CAP:
                capped = True
                continue
        if isinstance(seen, set):
            for n in [n for n in seen if n not in seen_prev and n in nodes]:
                ev.append({"type": "node_visit", "map": m, "id": nid(n)})
            seen_prev = set(seen)
            if cand is not None and cand in seen and cand != prev_cur and (prev_cur, cand) not in skipped:
                pending_skip = (prev_cur, cand)

    err = trace.get("error")
    if err:
        flash = {"type": "error_flash", "text": f"{err['type']}: {err['message']}"}
        if prev_cur is not None:
            flash["at"] = nid(prev_cur)
        ev.append(flash)
        if run == "draft":
            ev.append({"type": "caption", "role": "why", "text": problem["why_line"]})
    else:
        ev.append({"type": "caption", "role": "final", "text": trace["stdout"].strip()})
        if run == "draft":
            ev.append({"type": "caption", "role": "why", "text": problem["why_line"]})
    ev.append({"type": "scene_close"})
    return ev


def main(pid):
    problem = engine.get_problem(pid)
    if problem is None:
        print(f"no problem with id {pid!r}", file=sys.stderr)
        return 1
    out = {"contract": "stage-v1",
           "streams": {"draft": emit_stream(problem, "draft"), "fix": emit_stream(problem, "fix")}}
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python3 stage_emitter.py <problem id>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
