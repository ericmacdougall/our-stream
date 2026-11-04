#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Invariants over rendered chart manifests (run by ci/check.sh).

Every pod runs as non-root with privilege escalation disabled and all capabilities dropped; nothing is
privileged or uses host namespaces; the admin database URL is visible to the migrate Job and nothing else;
TRUST_PROXY is `false` or a CIDR list, never `true`; no development default secret appears anywhere; and the
rendering contains the expected number of resources per kind, so an optional template that silently renders
nothing cannot pass.

usage: assert-rendered.py --expect Kind=N [--expect Kind=N ...] rendered.yaml
"""
import argparse
import collections
import pathlib
import re
import sys

import yaml

POD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"}
# Prefix lengths broader than these would trust most of the internet; see _helpers.tpl "our-stream.trustProxy".
CIDR = re.compile(
    r"^([0-9]{1,3}\.){3}[0-9]{1,3}/([89]|[12][0-9]|3[0-2])$|^[0-9A-Fa-f:]+/(1[6-9]|[2-9][0-9]|1[01][0-9]|12[0-8])$"
)
REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]


def dev_secret_markers():
    """Development credentials the repository ships for compose, read from their sources so the list cannot
    drift: DEV_DEFAULTS in apps/api/src/config.ts and the `${VAR:-default}` fallbacks of password, secret
    and key variables in infra/docker/docker-compose.yml."""
    markers = set()
    config = (REPO_ROOT / "apps/api/src/config.ts").read_text(encoding="utf-8")
    block = re.search(r"DEV_DEFAULTS\s*=\s*\{(.*?)\}\s*as const", config, re.S)
    if not block:
        raise SystemExit("DEV_DEFAULTS block not found in apps/api/src/config.ts")
    markers.update(re.findall(r"'([^']+)'", block.group(1)))
    compose = (REPO_ROOT / "infra/docker/docker-compose.yml").read_text(encoding="utf-8")
    markers.update(re.findall(r"\$\{[A-Z0-9_]*(?:PASSWORD|SECRET|SECRET_KEY)[A-Z0-9_]*:-([^}]+)\}", compose))
    markers = {m for m in markers if len(m) >= 12}
    if len(markers) < 4:
        raise SystemExit(f"too few development secret markers found ({sorted(markers)}); sources changed?")
    return markers


def pod_spec(doc):
    spec = doc.get("spec", {}) or {}
    if doc.get("kind") == "CronJob":
        return spec["jobTemplate"]["spec"]["template"]["spec"]
    return spec["template"]["spec"]


def check(path, expectations, markers):
    problems = []
    text = pathlib.Path(path).read_text(encoding="utf-8")
    docs = [d for d in yaml.safe_load_all(text) if d]
    if not docs:
        return [f"{path}: no documents rendered"]
    for marker in sorted(markers):
        if marker in text:
            problems.append(f"{path}: development secret {marker!r} present in the rendering")

    counts = collections.Counter(d.get("kind") for d in docs)
    for kind, expected in expectations.items():
        if counts.get(kind, 0) != expected:
            problems.append(f"{path}: expected {expected} x {kind}, found {counts.get(kind, 0)}")

    admin_holders = []
    saw_api = False
    for doc in docs:
        kind = doc.get("kind")
        if kind not in POD_KINDS:
            continue
        name = doc.get("metadata", {}).get("name", "?")
        where = f"{kind}/{name}"
        spec = pod_spec(doc)
        for host_field in ("hostNetwork", "hostPID", "hostIPC"):
            if spec.get(host_field):
                problems.append(f"{where}: {host_field} is set")
        psc = spec.get("securityContext") or {}
        if psc.get("runAsNonRoot") is not True:
            problems.append(f"{where}: pod securityContext.runAsNonRoot is not true")
        containers = list(spec.get("containers") or []) + list(spec.get("initContainers") or [])
        if not containers:
            problems.append(f"{where}: no containers")
        for c in containers:
            cname = f"{where} container {c.get('name', '?')}"
            csc = c.get("securityContext") or {}
            if csc.get("privileged"):
                problems.append(f"{cname}: privileged")
            if csc.get("allowPrivilegeEscalation") is not False:
                problems.append(f"{cname}: allowPrivilegeEscalation is not false")
            if "ALL" not in ((csc.get("capabilities") or {}).get("drop") or []):
                problems.append(f"{cname}: capabilities.drop lacks ALL")
            if csc.get("runAsUser") == 0 or psc.get("runAsUser") == 0:
                problems.append(f"{cname}: runs as uid 0")
            if c.get("envFrom"):
                problems.append(f"{cname}: envFrom loads whole Secrets/ConfigMaps; use explicit keys")
            env = c.get("env") or []
            if any(e["name"] == "DATABASE_ADMIN_URL" for e in env):
                admin_holders.append(cname)
            if doc.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/component") == "api":
                saw_api = True
                tp = [e for e in env if e["name"] == "TRUST_PROXY"]
                if len(tp) != 1:
                    problems.append(f"{cname}: expected exactly one TRUST_PROXY, found {len(tp)}")
                else:
                    value = str(tp[0].get("value", ""))
                    if value != "false" and not all(CIDR.match(p) for p in value.split(",")):
                        problems.append(f"{cname}: TRUST_PROXY={value!r} is neither false nor a CIDR list")
                for e in env:
                    if e["name"] in ("DATABASE_PLATFORM_URL", "DATABASE_ADMIN_URL"):
                        problems.append(f"{cname}: api must not receive {e['name']}")
    if not saw_api:
        problems.append(f"{path}: no api Deployment rendered")
    outside_job = [h for h in admin_holders if not h.startswith("Job/")]
    if outside_job:
        problems.append(f"DATABASE_ADMIN_URL outside the migrate Job: {outside_job}")
    if not any(h.startswith("Job/") for h in admin_holders):
        problems.append("no Job carries DATABASE_ADMIN_URL (migrations would never run)")
    return problems


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect", action="append", default=[], metavar="Kind=N")
    ap.add_argument("rendered")
    args = ap.parse_args(argv)
    expectations = {}
    for item in args.expect:
        kind, _, n = item.partition("=")
        expectations[kind] = int(n)
    if not expectations:
        print("at least one --expect Kind=N is required", file=sys.stderr)
        return 2
    problems = check(args.rendered, expectations, dev_secret_markers())
    if problems:
        print("\n".join(problems))
        print(f"{len(problems)} invariant violation(s) in {args.rendered}")
        return 1
    print(f"invariants hold for {args.rendered} ({', '.join(f'{k}={v}' for k, v in expectations.items())})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
