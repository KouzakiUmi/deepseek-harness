"""Project the real headless guard transcript through the Python SDK transport reader."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness


def test_guard_prefix_and_attributed_continuation_do_not_finish_the_sdk_run_early(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    fixture = root / "snapshots/session/reasoning-loop-recovery/session.v4.jsonl"
    expected = json.loads((Path(__file__).parent / "expected/reasoning-loop-projection.json").read_text(encoding="utf-8"))
    script = tmp_path / "runtime.py"
    script.write_text('''
import json
import os
import sys

rows = [json.loads(line) for line in open(os.environ["SESSION_FIXTURE"], encoding="utf-8")]

def notify(method, params):
    print(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialize":
        result = {"serverInfo": {"name": "guard-reader-fixture"}}
    elif method == "session/prompt":
        sid = request["params"]["sessionId"]
        notify("session.status", {"sessionId": sid, "status": "running"})
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"messageId": "{{message:1}}"}}), flush=True)
        for seq, row in enumerate(rows[1:]):
            notify("session.event", {"sessionId": sid, "event": {**row, "seq": seq, "time": 0}})
        notify("session.status", {"sessionId": sid, "status": "idle"})
        continue
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {}}), flush=True)
        break
    else:
        raise RuntimeError("Unexpected protocol method: " + method)
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
'''.strip(), encoding="utf-8")
    with DeepSeekHarness(_launch_args=(sys.executable, str(script)), cwd=str(tmp_path),
                         env={"SESSION_FIXTURE": str(fixture)}) as harness:
        result = harness.run("inspect both epochs", session_id="guard-reader")
    partial = next(event for event in result.events if event["type"] == "assistant/message" and event["data"].get("interrupted"))
    continuation = next(event for event in result.events if event["type"] == "user/message"
                        and event["data"]["source"]["kind"] == "reasoning-loop-recovery")
    projection = {
        "finalResponse": result.final_response,
        "partialBlockTypes": [block["type"] for block in partial["data"]["message"]["content"]],
        "partialFailureCode": partial["data"]["stream"][-1]["chunk"]["reason"]["failure"]["code"],
        "continuationSource": continuation["data"]["source"]["kind"],
        "turnReasons": [event["data"]["reason"]["kind"] for event in result.events if event["type"] == "turn/end"],
    }
    assert projection == expected
    assert partial["seq"] < continuation["seq"]
    assert "replayState" not in partial["data"]["message"]["source"]
    assert continuation["data"]["content"][0]["text"].startswith("The preceding reasoning was interrupted")
