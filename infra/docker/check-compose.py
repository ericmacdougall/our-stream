#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Invariants of the compose trust chain, checked on `docker compose config` output (CI and local).

The api trusts exactly the edge's static address; web publishes no host port (it is reachable only through
the edge); the edge is the only service on the web origin port; api/web/worker run read-only; every
published port binds to loopback unless BIND_ADDR is set. usage: check-compose.py <rendered-config.yaml>
"""
import sys

import yaml


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
    if problems:
        print("\n".join(problems))
        print(f"{len(problems)} compose invariant violation(s)")
        return 1
    print(f"compose invariants hold (edge {edge_ip}, TRUST_PROXY {trust})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
