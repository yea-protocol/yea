"""Python client ↔ TS example servers (../examples/serve.ts). Skipped without Node ≥ 22.18
or a built ts/dist. Every reply is also rendered by the TS Lens renderer and compared
byte for byte with ours."""

import asyncio
import json
import os
import queue
import re
import shutil
import subprocess
import threading
from datetime import date, timedelta

import pytest
from conftest import ROOT

from yea import connect, consent_code, consent_grant, issue_grant, key_from_seed, lens

REPO = ROOT.parent
SEEDS = json.loads((REPO / "conformance" / "grants.json").read_text())["seeds"]
PRINCIPAL = key_from_seed(SEEDS["principal"])
AGENT = key_from_seed(SEEDS["agent"])


def _node_ok() -> bool:
    node = shutil.which("node")
    if not node or not (REPO / "ts" / "dist" / "index.js").exists():
        return False
    major, minor = (int(x) for x in subprocess.check_output([node, "-p", "process.versions.node"], text=True).split(".")[:2])
    return (major, minor) >= (22, 18)


NODE_OK = _node_ok()
if not NODE_OK and os.environ.get("YEA_REQUIRE_INTEROP"):
    raise RuntimeError("YEA_REQUIRE_INTEROP is set but node >= 22.18 or ts/dist is missing")
pytestmark = pytest.mark.skipif(not NODE_OK, reason="needs node >= 22.18 and a built ts/dist")


UP = re.compile(r"(\w+) yea://(\S+) http://(\S+)/yea")


def _read_ports(proc: subprocess.Popen, found: queue.Queue) -> None:
    """Read the servers' stderr until the "up" line, then keep draining it."""
    assert proc.stderr
    log = ""
    for line in proc.stderr:
        log += line
        if "examples up" in line:
            found.put({name: (tcp, http) for name, tcp, http in UP.findall(line)})
    found.put(log)


@pytest.fixture(scope="module")
def ts_servers():
    """Start examples/serve.ts on free ports (YEA_PORT=0) and yield the ports it reports,
    so parallel runs never reach each other's servers."""
    proc = subprocess.Popen(
        ["node", "examples/serve.ts"], cwd=REPO, env={**os.environ, "YEA_TRUST": PRINCIPAL.public, "YEA_PORT": "0"},
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    found: queue.Queue = queue.Queue()
    threading.Thread(target=_read_ports, args=(proc, found), daemon=True).start()
    try:
        ports = found.get(timeout=15)
    except queue.Empty:
        ports = "timed out"
    if not isinstance(ports, dict):
        proc.kill()
        pytest.fail(f"TS servers did not start: {ports}")
    yield ports
    proc.terminate()
    proc.wait(5)


def ts_lens(frames: list[dict]) -> list[str]:
    """Render frames with the TS reference renderer."""
    script = (
        "import(process.argv[1]).then(m=>{let s='';process.stdin.on('data',d=>s+=d);"
        "process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(f=>m.lens(f)))))})"
    )
    out = subprocess.run(
        ["node", "-e", script, (REPO / "ts" / "dist" / "index.js").as_uri()],
        input=json.dumps(frames), capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def ts_eval(fn: str, arg):
    """Call an exported TS function on one JSON argument."""
    script = (
        "import(process.argv[1]).then(m=>{let s='';process.stdin.on('data',d=>s+=d);"
        f"process.stdin.on('end',()=>process.stdout.write(JSON.stringify(m.{fn}(JSON.parse(s)))))}})"
    )
    out = subprocess.run(
        ["node", "-e", script, (REPO / "ts" / "dist" / "index.js").as_uri()],
        input=json.dumps(arg), capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def ts_eval2(fn: str, a, b):
    script = (
        "import(process.argv[1]).then(m=>{let s='';process.stdin.on('data',d=>s+=d);"
        f"process.stdin.on('end',()=>{{const [a,b]=JSON.parse(s);process.stdout.write(JSON.stringify(m.{fn}(a,b)))}})}})"
    )
    out = subprocess.run(
        ["node", "-e", script, (REPO / "ts" / "dist" / "index.js").as_uri()],
        input=json.dumps([a, b]), capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def assert_same_lens(replies):
    frames = [r.frame for r in replies] + [e.frame for r in replies for e in r.events]
    assert [lens(f) for f in frames] == ts_lens(frames)


@pytest.mark.parametrize("transport", ["tcp", "http"])
def test_calendar_flow(ts_servers, transport):
    tcp, http = ts_servers["calendar"]
    url = f"yea://{tcp}" if transport == "tcp" else f"http://{http}/yea"
    g = issue_grant(PRINCIPAL, AGENT.public, [{"svc": ["calendar.example"]}, {"can": ["calendar.*"]}])

    async def go():
        seen = []
        async with await connect(url, key=AGENT.seed, grants=[g]) as c:
            brief = await c.hello()
            assert brief.kind == "BRIEF" and c.service_id == "calendar.example"
            agenda = await c.ask("calendar.agenda")
            assert agenda.kind == "ANSWER" and [e["id"] for e in agenda.data][:3] == ["e1", "e2", "e3"]
            clar = await c.intent("calendar.reschedule", {"event": "Ana"})
            assert clar.kind == "CLARIFY" and len(clar.options) == 3
            props = await c.intent("calendar.reschedule", {"event": "Ana", **clar.options[0]["params"]})
            assert props.kind == "PROPOSALS" and props.proposals
            rc = await c.commit(props.proposals[0])
            assert rc.kind == "RECEIPT", rc.lens
            replay = await c.commit(props.proposals[0])
            assert replay.replay is True and replay.receipt["id"] == rc.receipt["id"]
            undo = await c.undo(rc.receipt["id"])
            assert undo.kind == "RECEIPT" and undo.receipt["undoes"] == rc.receipt["id"], undo.lens
            bad = await c.ask("calendar.agenda", {"quer": "ana"})
            assert bad.code == "invalid_params" and bad.fix[0]["params"] == {"quer": None, "query": "ana"}
            small = await c.ask("calendar.agenda", budget=60)
            assert small.more and (await c.expand(small.more[0]["handle"])).kind == "ANSWER"
            auto = await c.intent("calendar.reschedule", {"event": "e8", "day": clar.options[0]["label"].split(" · ")[1][:10]}, auto=True)
            assert auto.kind == "RECEIPT" and auto.auto is True, auto.lens
            assert auto.lens.splitlines()[1].startswith("  ~ update event/e8.start")
            seen += [brief, agenda, clar, props, rc, replay, undo, bad, small, auto]
        assert_same_lens(seen)

    asyncio.run(go())


def test_shop_consent_flow(ts_servers):
    tcp, _ = ts_servers["shop"]
    g = issue_grant(PRINCIPAL, AGENT.public, [{"svc": ["shop.example"]}, {"each": {"of": "spend", "max": 5000, "scale": 2, "unit": "USD"}}])
    deliver = (date.today() + timedelta(days=2)).isoformat()

    async def go():
        async with await connect(f"yea://{tcp}", key=AGENT, grants=[g]) as c:
            props = await c.intent("shop.order", {"items": [{"sku": "m002", "qty": 4}], "deliver": deliver})
            assert props.kind == "PROPOSALS", props.lens
            p = props.proposals[0]
            assert p["uses"]["spend"]["amount"] > 5000
            need = await c.commit(p)
            assert need.code == "consent_required" and need.consent["hash"] == p["hash"]
            assert need.consent["principal"] == PRINCIPAL.public
            assert list(need.consent) == ["proposal", "hash", "service", "capability", "principal", "summary", "expires"]
            assert consent_code(need.consent) == ts_eval("consentCode", need.consent)
            assert consent_code(need.consent, p) == ts_eval2("consentCode", need.consent, p)
            ok = await c.commit(p, grants=[consent_grant(PRINCIPAL, AGENT.public, need.consent)])
            assert ok.kind == "RECEIPT", ok.lens
            assert_same_lens([props, need, ok])

    asyncio.run(go())
