"""Run the e2e server: `langgraph dev` on `langgraph.e2e.json`, minus file persistence.

`langgraph dev` keeps its threads, checkpoints and store in `.langgraph_api/`
under the working directory, which for this suite is the repo root, the same
place `mise run dev` keeps a developer's. A run loaded that state, wrote its
own back over it, and started from whatever earlier runs left. The CLI drops
`disable_persistence` from the config file and forces the matching environment
variable off, so this makes the CLI's own `run_server` call with it on.

    uv run python tests/e2e/serve.py --port 2024
"""

import argparse
import json
import os
import sys
from pathlib import Path

from langgraph_api.cli import run_server

CONFIG = Path(__file__).with_name("langgraph.e2e.json")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2024)
    args = parser.parse_args()

    config = json.loads(CONFIG.read_text())
    # What `langgraph dev` does with the working directory and `dependencies`.
    cwd = os.getcwd()
    sys.path.append(cwd)
    for dependency in config.get("dependencies", []):
        path = Path(cwd) / dependency
        if path.is_dir():
            sys.path.append(str(path))

    run_server(
        args.host,
        args.port,
        reload=False,
        graphs=config.get("graphs", {}),
        env=config.get("env"),
        store=config.get("store"),
        auth=config.get("auth"),
        http=config.get("http"),
        allow_blocking=True,
        disable_persistence=True,
    )


if __name__ == "__main__":
    main()
