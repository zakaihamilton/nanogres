#!/usr/bin/python3
"""Return only unexpired, loopback-forwarding-only Nanogres workload keys."""

from __future__ import annotations

import sys

sys.path.insert(0, "/opt/nanogres-api")

import api  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        return 0
    key = api.workload_authorized_ssh_key(sys.argv[1], sys.argv[2])
    if key:
        print(key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
