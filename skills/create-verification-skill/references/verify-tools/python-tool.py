#!/usr/bin/env python3
"""TEMPLATE for a project verification tool (python 3, standard library only).

Copy it into the project's tools folder (e.g. tools/verify/check_http.py), rename it after what it proves,
replace the EXAMPLE probe below with the project's real check and rewrite DESCRIPTION. Keep the contract:
--help, one bounded JSON object on stdout, exit 0 pass / 1 fail / 2 bad usage,
read-only unless pointed at a test environment the tool itself created.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

TOOL = "check_http"  # EXAMPLE name: use the file name.
MAX_DETAIL = 300  # characters per check detail; keeps the output small enough for an agent's context
MAX_CHECKS = 20

DESCRIPTION = """EXAMPLE: check that HTTP endpoints of a running local instance answer as expected.

Read-only: sends GET requests only. Does not start, stop or change anything.
Output: one JSON object on stdout: {"tool", "ok", "checks": [{"name", "ok", "detail"}]}.
Exit codes: 0 every check passed, 1 a check failed or got no answer, 2 bad usage."""


def emit(ok, checks, code):
    checks = checks[:MAX_CHECKS]
    for c in checks:
        c["detail"] = str(c.get("detail", ""))[:MAX_DETAIL]
    print(json.dumps({"tool": TOOL, "ok": ok, "checks": checks}))
    sys.exit(code)


def probe(url, expect, timeout):
    """EXAMPLE probe: replace with the project's own check (a CLI call, a query on a test database, a file)."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout) as res:
            status = res.status
    except urllib.error.HTTPError as err:
        status = err.code
    except (urllib.error.URLError, OSError) as err:
        return {"name": url, "ok": False, "detail": f"no answer: {err}"}
    return {"name": url, "ok": status == expect, "detail": f"status {status}, expected {expect}"}


def main():
    parser = argparse.ArgumentParser(prog=TOOL, description=DESCRIPTION, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", action="append", required=True, help="endpoint to GET; repeatable")
    parser.add_argument("--expect", type=int, default=200, help="expected HTTP status (default 200)")
    parser.add_argument("--timeout", type=float, default=5.0, help="seconds per request (default 5)")
    try:
        args = parser.parse_args()
    except SystemExit as exit_:
        if exit_.code == 0:  # --help
            raise
        emit(False, [{"name": "usage", "ok": False, "detail": "bad arguments, see --help"}], 2)
    checks = [probe(url, args.expect, args.timeout) for url in args.url]
    ok = all(c["ok"] for c in checks)
    emit(ok, checks, 0 if ok else 1)


if __name__ == "__main__":
    main()
