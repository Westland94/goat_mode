"""Stage contract v1 checker (see stage_contract.md).

Run:  python3 app/stage_check.py <stream.json>
Accepts {"streams": {name: [events]}} or a bare [events] list. For every stream:
every event's type is in the contract, its required fields are present with the right
types, it carries no fields the contract doesn't define, enum fields hold allowed
values, and the stream opens with scene_open and closes with scene_close.
v2 (Task 104): graph events need a map: id and node: ids, and every node is added before
anything references it. Streams over the scale guard (14 nodes / 400 events) pass with a
"not stageable" WARN line. Prints OK per stream, or the first violation (exit 1).
"""
import json
import sys

S, V = (str,), (str, int, float)  # string field / display-value field
EVENTS = {  # type: (required {field: types}, optional {field: types})
    "scene_open": ({"title": S, "job": S}, {}),
    "actor_arrive": ({"actor": S, "label": S}, {"to": S}),
    "container_appear": ({"id": S, "kind": S, "label": S}, {"value": V}),
    "container_add": ({"id": S, "value": V}, {"item": V}),
    "item_discard": ({"id": S, "item": V}, {"note": S}),
    "gauge_step": ({"id": S, "value": V}, {"max": V, "label": S}),
    "gate_block": ({"id": S}, {"label": S, "actor": S}),
    "gate_open": ({"id": S}, {"label": S}),
    "error_flash": ({"text": S}, {"at": S}),
    "caption": ({"role": S, "text": S}, {}),
    "scene_close": ({}, {}),
    # v2 (Task 104): the graph (map) device
    "node_add": ({"map": S, "id": S, "label": S}, {}),
    "edge_add": ({"map": S, "from": S, "to": S}, {}),
    "node_current": ({"map": S, "id": S}, {}),
    "node_visit": ({"map": S, "id": S}, {}),
    "edge_skip": ({"map": S, "from": S, "to": S}, {}),
    "node_found": ({"map": S, "id": S}, {}),
}
GRAPH = {"node_add", "edge_add", "node_current", "node_visit", "edge_skip", "node_found"}
MAX_NODES, MAX_EVENTS = 14, 400  # the scale guard: bigger streams are valid but not stageable
ENUMS = {("container_appear", "kind"): {"jar", "tray"},
         ("caption", "role"): {"draft", "why", "fix", "final"}}


def check_stream(events):
    """Return the first violation as a string, or None if the stream is valid."""
    if not isinstance(events, list) or not events:
        return "stream must be a non-empty list of events"
    for i, ev in enumerate(events):
        where = f"event {i}"
        if not isinstance(ev, dict):
            return f"{where}: not an object"
        t = ev.get("type")
        if t not in EVENTS:
            return f"{where}: unknown type {t!r}"
        req, opt = EVENTS[t]
        for f, ty in req.items():
            if f not in ev:
                return f"{where} ({t}): missing required field '{f}'"
        for f, val in ev.items():
            if f == "type":
                continue
            ty = req.get(f) or opt.get(f)
            if ty is None:
                return f"{where} ({t}): field '{f}' is not in the contract"
            if isinstance(val, bool) or not isinstance(val, ty):
                return f"{where} ({t}): field '{f}' has the wrong type ({type(val).__name__})"
            allowed = ENUMS.get((t, f))
            if allowed and val not in allowed:
                return f"{where} ({t}): '{f}' must be one of {sorted(allowed)}, got {val!r}"
    err = check_graph(events)
    if err:
        return err
    if events[0].get("type") != "scene_open":
        return "first event must be scene_open"
    if events[-1].get("type") != "scene_close":
        return "last event must be scene_close"
    return None


def check_graph(events):
    """v2 graph rules: map/node id prefixes, node-before-reference, no duplicate nodes."""
    nodes = set()
    for i, ev in enumerate(events):
        t = ev["type"]
        if t not in GRAPH:
            continue
        where = f"event {i} ({t})"
        if not ev["map"].startswith("map:"):
            return f"{where}: map id {ev['map']!r} must start with 'map:'"
        if t == "node_add":
            if not ev["id"].startswith("node:"):
                return f"{where}: node id {ev['id']!r} must start with 'node:'"
            if ev["id"] in nodes:
                return f"{where}: node {ev['id']!r} was already added"
            nodes.add(ev["id"])
            continue
        for f in ("id", "from", "to"):
            if f in ev and ev[f] not in nodes:
                return f"{where}: {f} references node {ev[f]!r} that was never added (node_add must come first)"
    return None


def stage_warning(events):
    """The scale guard: valid but too big to stage. Returns a warning string or None."""
    n_nodes = sum(1 for e in events if isinstance(e, dict) and e.get("type") == "node_add")
    why = []
    if n_nodes > MAX_NODES:
        why.append(f"{n_nodes} nodes > {MAX_NODES}")
    if len(events) > MAX_EVENTS:
        why.append(f"{len(events)} events > {MAX_EVENTS}")
    return "not stageable (" + ", ".join(why) + ") — valid, but big inputs stay headless" if why else None


def main(path):
    with open(path) as f:
        data = json.load(f)
    streams = data.get("streams") if isinstance(data, dict) else {"stream": data}
    if not isinstance(streams, dict) or not streams:
        print("FAIL  no streams found")
        return 1
    for name, events in streams.items():
        err = check_stream(events)
        if err:
            print(f"FAIL  {name}: {err}")
            return 1
        warn = stage_warning(events)
        if warn:
            print(f"WARN  {name}: {warn}")
        print(f"OK    {name}: {len(events)} events")
    print("OK")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python3 stage_check.py <stream.json>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
