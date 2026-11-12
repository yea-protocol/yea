"""The README's quickstart (examples/quickstart.py, shown there whole) runs as its own process: the
agent reads the plan, commits it under the person's grant, and undoes it."""

import subprocess
import sys
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "quickstart.py"


def test_the_quickstart_moves_a_meeting_then_undoes_it():
    run = subprocess.run([sys.executable, str(EXAMPLE)], capture_output=True, text=True, timeout=60)

    assert run.returncode == 0, run.stderr
    assert "] Move e2 to 2026-09-24T15:00:00Z\n" in run.stdout  # the plan, as the model reads it
    assert "risk: low · undo: 1h" in run.stdout
    assert "✓ Move e2 to 2026-09-24T15:00:00Z (receipt r_" in run.stdout  # the grant allowed it
    assert "↶ undid r_" in run.stdout
