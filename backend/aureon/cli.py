"""Command-line entry point.

    python -m aureon.cli serve                       # run the web app
    python -m aureon.cli import [files...]           # ingest files (default: everything in data/import)
    python -m aureon.cli collect --start 2026-10-01 --end 2026-10-23    # TinyFish collection
    python -m aureon.cli status
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from .config import get_settings
from .data.pipeline import collect_tinyfish, collect_tinyfish_contract, ingest_import_dir, ingest_text
from .data.store import Store
from .jsonify import to_jsonable
from .logging_setup import configure_logging


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="aureon")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    imp = sub.add_parser("import")
    imp.add_argument("files", nargs="*")
    col = sub.add_parser("collect")
    col.add_argument("--start", required=True)
    col.add_argument("--end")
    cc = sub.add_parser("collect-contract")
    cc.add_argument("--symbol", required=True)
    cc.add_argument("--expiry", required=True)
    cc.add_argument("--start", required=True)
    cc.add_argument("--end", required=True)
    sub.add_parser("status")
    sub.add_parser("prebuild", help="build the database and ready-made page answers for deployment")
    args = ap.parse_args(argv)

    s = get_settings()
    configure_logging(s.log_level)
    if args.cmd == "serve":
        from .api import main as serve
        serve()
        return 0
    if args.cmd == "prebuild":
        from .prebuild import prebuild
        print(json.dumps(to_jsonable(prebuild(s)), indent=2))
        return 0
    store = Store(s.database)
    if args.cmd == "import":
        if args.files:
            out = []
            for f in args.files:
                p = Path(f)
                run = store.start_run("file_import", {"file": p.name})
                res = ingest_text(store, s, p.read_text(encoding="utf-8-sig"), "file_import", {"file": p.name}, p.name)
                store.finish_run(run, "error" if "error" in res else "ok", res)
                out.append({"file": p.name, **res})
        else:
            out = ingest_import_dir(store, s)
        print(json.dumps(to_jsonable(out), indent=2))
    elif args.cmd == "collect":
        res = collect_tinyfish(store, s, date.fromisoformat(args.start), date.fromisoformat(args.end or args.start))
        print(json.dumps(to_jsonable({k: v for k, v in res.items() if k != "days"}), indent=2))
    elif args.cmd == "collect-contract":
        res = collect_tinyfish_contract(store, s, args.symbol.upper(), date.fromisoformat(args.expiry),
                                        date.fromisoformat(args.start), date.fromisoformat(args.end))
        print(json.dumps(to_jsonable(res), indent=2))
    elif args.cmd == "status":
        print(json.dumps(store.counts(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
