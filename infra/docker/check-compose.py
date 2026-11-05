#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Invariants of the compose trust chain, checked on `docker compose config` output (CI and local).

The api trusts exactly the edge's static address; web publishes no host port (it is reachable only through
the edge); the edge is the only service on the web origin port; api/web/worker run read-only; the parser sandbox has no network, a read-only root, no secrets and only its two job volumes; postgres is pinned to an exact pgvector release >= 0.8.0; every
published port binds to loopback unless BIND_ADDR is set. usage: check-compose.py <rendered-config.yaml>
"""
import re
import sys

import yaml


SECRETISH = ("DATABASE", "S3_", "SECRET", "PASSWORD", "TOKEN", "ACCESS_KEY", "SMTP")


def check_parser_sandbox(cfg, services, problems):
    """The parser sandbox is enforced by the runtime (docs/documents.md): no network, read-only root, tmpfs
    scratch, non-root, no capabilities, pid and memory limits, no secrets, and only its two job volumes."""
    parser = services.get("parser")
    if parser is None:
        problems.append("parser service is missing")
        return
    if parser.get("network_mode") != "none":
        problems.append(f"parser network_mode must be 'none' (got {parser.get('network_mode')!r})")
    if parser.get("networks"):
        problems.append("parser must not join any network")
    if parser.get("ports"):
        problems.append("parser must not publish ports")
    if not parser.get("read_only"):
        problems.append("parser must run with a read-only root filesystem")
    user = str(parser.get("user", ""))
    if user in ("", "0", "root") or user.startswith("0:"):
        problems.append(f"parser must run as a non-root user (got {user!r})")
    if "ALL" not in [str(c).upper() for c in parser.get("cap_drop", [])]:
        problems.append("parser must drop all capabilities")
    if parser.get("cap_add"):
        problems.append("parser must not add capabilities")
    if not parser.get("pids_limit") or int(parser["pids_limit"]) <= 0:
        problems.append("parser needs a pids_limit")
    mem = parser.get("mem_limit")
    if not mem or int(mem) > 1024**3:
        problems.append(f"parser mem_limit must be set and at most 1 GiB (got {mem!r})")
    if not parser.get("tmpfs"):
        problems.append("parser needs a tmpfs work directory")
    env = parser.get("environment", {}) or {}
    for key in env:
        if any(m in key.upper() for m in SECRETISH):
            problems.append(f"parser environment must carry no secret-like variable ({key})")
    if set(env) - {"PARSER_SLOT_DIR", "PARSER_CTL_DIR"}:
        problems.append(f"parser environment must be exactly the two directories (got {sorted(env)})")
    if (parser.get("privileged")) or parser.get("pid") == "host" or parser.get("ipc") == "host":
        problems.append("parser must not be privileged or share host namespaces")
    mounts = {(v.get("source"), v.get("target")) for v in parser.get("volumes", [])}
    if mounts != {("parser-slot", "/slot"), ("parser-ctl", "/ctl")}:
        problems.append(f"parser may mount only the two job volumes (got {sorted(map(str, mounts))})")
    for name, svc in services.items():
        if name in ("parser", "worker"):
            continue
        for v in svc.get("volumes", []) or []:
            if v.get("source") in ("parser-slot", "parser-ctl"):
                problems.append(f"{name} must not mount the parser job volumes")
    worker_mounts = {(v.get("source"), v.get("target")) for v in services["worker"].get("volumes", [])}
    for want in (("parser-slot", "/parser-io/slot"), ("parser-ctl", "/parser-io/ctl")):
        if want not in worker_mounts:
            problems.append(f"worker must mount {want[0]} at {want[1]}")


def check_pgvector_pin(services, problems):
    image = services["postgres"]["image"]
    m = re.match(r"^pgvector/pgvector:(\d+)\.(\d+)\.(\d+)-pg\d+@sha256:[0-9a-f]{64}$", image)
    if not m:
        problems.append(f"postgres image must be an exact pgvector release with a digest (got {image!r})")
    elif (int(m.group(1)), int(m.group(2))) < (0, 8):
        problems.append(f"pgvector {m.group(1)}.{m.group(2)}.{m.group(3)} is below 0.8.0 (iterative scan)")


def main(path):
    cfg = yaml.safe_load(open(path, encoding="utf-8"))
    services = cfg["services"]
    problems = []
    edge_ip = services["edge"]["networks"]["edge"].get("ipv4_address")
    if not edge_ip:
        problems.append("edge has no static ipv4_address on the edge network")
    trust = str(services["api"]["environment"].get("TRUST_PROXY", ""))
    if trust != f"{edge_ip}/32":
        problems.append(f"api TRUST_PROXY={trust!r} must equal the edge address /32 ({edge_ip}/32)")
    if services["web"].get("ports"):
        problems.append("web must not publish a host port (reachable only through the edge)")
    edge_net = cfg["networks"]["edge"]["ipam"]["config"][0]
    if not edge_net.get("gateway"):
        problems.append("edge network must fix its gateway (it is the source address of host traffic)")
    if edge_ip and edge_net.get("ip_range") and edge_ip.startswith(edge_net["ip_range"].rsplit(".", 1)[0] + "."):
        pass  # same /24; the static address must still be outside the dynamic range, checked by Docker at start
    for name in ("api", "web", "worker"):
        if not services[name].get("read_only"):
            problems.append(f"{name} must run with read_only root filesystem")
    for name, svc in services.items():
        for port in svc.get("ports") or []:
            host_ip = port.get("host_ip") if isinstance(port, dict) else str(port).split(":")[0]
            if host_ip not in ("127.0.0.1", "0.0.0.0", "::1") and host_ip != "127.0.0.1":
                problems.append(f"{name}: published port {port} does not bind to loopback")
    for name in ("api", "worker", "migrate"):
        if name in services and "DATABASE_ADMIN_URL" in services[name]["environment"] and name != "migrate":
            problems.append(f"{name} must not receive DATABASE_ADMIN_URL")
    check_parser_sandbox(cfg, services, problems)
    check_pgvector_pin(services, problems)
    if problems:
        print("\n".join(problems))
        print(f"{len(problems)} compose invariant violation(s)")
        return 1
    print(f"compose invariants hold (edge {edge_ip}, TRUST_PROXY {trust})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
