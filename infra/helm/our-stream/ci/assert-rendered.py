#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Invariants over rendered chart manifests (run by ci/check.sh).

Every pod runs as non-root with privilege escalation disabled and all capabilities dropped; nothing is
privileged or uses host namespaces; the admin database URL is visible to the migrate Job and nothing else;
TRUST_PROXY is `false` or a CIDR list (never `true`, never IPv4-mapped IPv6); no development default secret
appears anywhere; routing never sends /api or /media to web and always sends /api to the api; the api and
web allow-policies name a non-empty ingress namespace and never admit web into the api; and the rendering
contains the expected number of resources per kind, so an optional template that silently renders nothing
cannot pass.

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
V4_MAPPED = re.compile(r"^::ffff:", re.I)
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


def component(doc):
    return (doc.get("metadata", {}).get("labels") or {}).get("app.kubernetes.io/component")


def trust_proxy_ok(value):
    if value == "false":
        return True
    parts = value.split(",")
    return all(CIDR.match(p) and not V4_MAPPED.match(p) for p in parts)


def check_workloads(docs, problems):
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
            if component(doc) == "api":
                saw_api = True
                tp = [e for e in env if e["name"] == "TRUST_PROXY"]
                if len(tp) != 1:
                    problems.append(f"{cname}: expected exactly one TRUST_PROXY, found {len(tp)}")
                elif not trust_proxy_ok(str(tp[0].get("value", ""))):
                    problems.append(f"{cname}: TRUST_PROXY={tp[0].get('value')!r} is neither false nor a safe CIDR list")
                for e in env:
                    if e["name"] in ("DATABASE_PLATFORM_URL", "DATABASE_ADMIN_URL"):
                        problems.append(f"{cname}: api must not receive {e['name']}")
    if not saw_api:
        problems.append("no api Deployment rendered")
    outside_job = [h for h in admin_holders if not h.startswith("Job/")]
    if outside_job:
        problems.append(f"DATABASE_ADMIN_URL outside the migrate Job: {outside_job}")
    if not any(h.startswith("Job/") for h in admin_holders):
        problems.append("no Job carries DATABASE_ADMIN_URL (migrations would never run)")


def check_routing(docs, problems):
    """/api and /media must reach the api Service, never the web Service, and a /api route must exist."""
    web_services = {d["metadata"]["name"] for d in docs if d.get("kind") == "Service" and component(d) == "web"}
    api_services = {d["metadata"]["name"] for d in docs if d.get("kind") == "Service" and component(d) == "api"}
    api_route = False
    for doc in docs:
        kind = doc.get("kind")
        name = doc.get("metadata", {}).get("name", "?")
        if kind == "Ingress":
            for rule in doc["spec"].get("rules") or []:
                for p in (rule.get("http") or {}).get("paths") or []:
                    backend = p["backend"]["service"]["name"]
                    path = p.get("path", "/")
                    if path.startswith("/api") or path.startswith("/media"):
                        if backend in web_services:
                            problems.append(f"Ingress/{name}: {path} routed to web Service {backend}")
                        if path.startswith("/api") and backend in api_services:
                            api_route = True
        elif kind == "HTTPRoute":
            for rule in doc["spec"].get("rules") or []:
                paths = [m.get("path", {}).get("value", "/") for m in rule.get("matches") or []]
                backends = [b["name"] for b in rule.get("backendRefs") or []]
                for path in paths:
                    if path.startswith("/api") or path.startswith("/media"):
                        if any(b in web_services for b in backends):
                            problems.append(f"HTTPRoute/{name}: {path} routed to web Service")
                        if path.startswith("/api") and any(b in api_services for b in backends):
                            api_route = True
    if any(d.get("kind") in ("Ingress", "HTTPRoute") for d in docs) and not api_route:
        problems.append("no Ingress/HTTPRoute sends /api to the api Service (requests would fall through to web)")


def check_network_policies(docs, problems):
    """Allow-policies for web and api must name an ingress namespace and the api policy must not admit web."""
    for doc in docs:
        if doc.get("kind") != "NetworkPolicy":
            continue
        name = doc["metadata"]["name"]
        target = (doc["spec"].get("podSelector") or {}).get("matchLabels") or {}
        comp = target.get("app.kubernetes.io/component")
        if comp not in ("web", "api"):
            continue
        for rule in doc["spec"].get("ingress") or []:
            for peer in rule.get("from") or []:
                ns = peer.get("namespaceSelector")
                if ns is not None and not (ns.get("matchLabels") or ns.get("matchExpressions")):
                    problems.append(f"NetworkPolicy/{name}: empty namespaceSelector admits every namespace")
                ps = (peer.get("podSelector") or {}).get("matchLabels") or {}
                if comp == "api" and ps.get("app.kubernetes.io/component") == "web":
                    problems.append(f"NetworkPolicy/{name}: web pods must not be allowed to reach the api")


def quantity_bytes(q):
    m = re.match(r"^([0-9]+)(Ki|Mi|Gi|Ti)?$", str(q))
    if not m:
        return None
    return int(m.group(1)) * {None: 1, "Ki": 1024, "Mi": 1024**2, "Gi": 1024**3, "Ti": 1024**4}[m.group(2)]


def check_parser(docs, problems):
    """The parser sandbox (M2a): one replica, no Secret, no token, a read-only root, bounded memory, only the
    shared job volume and a memory-backed /tmp, and a deny-all ingress+egress NetworkPolicy of its own. Nothing
    else may mount the job claim except the worker."""
    parsers = [d for d in docs if d.get("kind") == "Deployment" and component(d) == "parser"]
    if not parsers:
        return
    if len(parsers) != 1:
        problems.append(f"expected one parser Deployment, found {len(parsers)}")
    doc = parsers[0]
    where = f"Deployment/{doc['metadata']['name']}"
    spec = doc["spec"]
    pod = pod_spec(doc)
    if spec.get("replicas") != 1:
        problems.append(f"{where}: parser must have exactly one replica (one job slot)")
    if pod.get("automountServiceAccountToken") is not False:
        problems.append(f"{where}: parser must not mount a ServiceAccount token")
    for c in pod.get("containers") or []:
        cname = f"{where} container {c.get('name')}"
        if (c.get("securityContext") or {}).get("readOnlyRootFilesystem") is not True:
            problems.append(f"{cname}: parser must have a read-only root filesystem")
        for e in c.get("env") or []:
            if "valueFrom" in e:
                problems.append(f"{cname}: parser must not read Secrets or ConfigMaps ({e['name']})")
            if e["name"] not in ("NODE_ENV", "PARSER_SLOT_DIR", "PARSER_CTL_DIR"):
                problems.append(f"{cname}: parser environment must be only its directories (got {e['name']})")
        limit = quantity_bytes(((c.get("resources") or {}).get("limits") or {}).get("memory"))
        if limit is None or limit > 1024**3:
            problems.append(f"{cname}: parser memory limit must be set and at most 1Gi")
        mounts = {(m["name"], m.get("subPath")) for m in c.get("volumeMounts") or []}
        if mounts != {("io", "slot"), ("io", "ctl"), ("tmp", None)}:
            problems.append(f"{cname}: parser may mount only the job slot, ctl and /tmp (got {sorted(map(str, mounts))})")
    kinds = {v["name"]: [k for k in v if k != "name"] for v in pod.get("volumes") or []}
    if kinds != {"io": ["persistentVolumeClaim"], "tmp": ["emptyDir"]}:
        problems.append(f"{where}: parser volumes must be the job claim and an emptyDir (got {kinds})")
    policies = [
        d for d in docs
        if d.get("kind") == "NetworkPolicy"
        and ((d["spec"].get("podSelector") or {}).get("matchLabels") or {}).get("app.kubernetes.io/component") == "parser"
    ]
    deny = [
        p for p in policies
        if sorted(p["spec"].get("policyTypes") or []) == ["Egress", "Ingress"]
        and not p["spec"].get("ingress")
        and not p["spec"].get("egress")
    ]
    if not deny:
        problems.append("no parser deny-all NetworkPolicy (Ingress and Egress, no rules) selects the parser pods")
    if len(policies) != len(deny):
        problems.append("a NetworkPolicy selecting the parser pods allows traffic; the parser must be deny-all")
    claim = next((v["persistentVolumeClaim"]["claimName"] for v in pod.get("volumes") or [] if v["name"] == "io"), None)
    for d in docs:
        if d.get("kind") not in POD_KINDS or d is doc:
            continue
        for v in pod_spec(d).get("volumes") or []:
            if (v.get("persistentVolumeClaim") or {}).get("claimName") == claim and component(d) != "worker":
                problems.append(f"{d['kind']}/{d['metadata']['name']}: only the worker may mount the parser job claim")


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
    check_workloads(docs, problems)
    check_routing(docs, problems)
    check_network_policies(docs, problems)
    check_parser(docs, problems)
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
