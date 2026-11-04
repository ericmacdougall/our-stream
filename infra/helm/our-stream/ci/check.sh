#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Chart gate, run by CI and locally: lint, render, validate against pinned Kubernetes schemas, then assert the
# chart's invariants on the rendered manifests (ci/assert-rendered.py). Every assertion has a failing control
# below so none of them can pass vacuously. Needs helm, kubeconform and python3 with PyYAML on PATH.
set -euo pipefail

CHART=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$(cd "$CHART/../../.." && pwd)
K8S_VERSION=${K8S_VERSION:-1.34.0}
# Pinned to a commit so a catalog change cannot silently alter what passes.
CRD_CATALOG_COMMIT=6ab3493622cd387923a2d0da5234f53e80e1bd28
CRD_CATALOG="https://raw.githubusercontent.com/datreeio/CRDs-catalog/${CRD_CATALOG_COMMIT}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
ASSERT="$CHART/ci/assert-rendered.py"

echo "== versions"
helm version --short
kubeconform -v

echo "== appVersion tracks the repository"
check_app_version() {
  local chart_dir=$1
  local repo_version chart_app_version
  repo_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/package.json")
  chart_app_version=$(python3 -c 'import yaml,sys; print(yaml.safe_load(open(sys.argv[1]))["appVersion"])' "$chart_dir/Chart.yaml")
  [ "$repo_version" = "$chart_app_version" ] || { echo "Chart.yaml appVersion ($chart_app_version) != package.json version ($repo_version)" >&2; return 1; }
}
check_app_version "$CHART"

echo "== helm lint"
helm lint --strict "$CHART"
helm lint --strict "$CHART" -f "$CHART/ci/full-values.yaml"

echo "== helm template"
helm template our-stream "$CHART" --namespace our-stream > "$OUT/default.yaml"
helm template our-stream "$CHART" --namespace our-stream -f "$CHART/ci/full-values.yaml" > "$OUT/full.yaml"

echo "== kubeconform (Kubernetes $K8S_VERSION, CRD catalog @ ${CRD_CATALOG_COMMIT:0:7})"
kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default -schema-location "$CRD_CATALOG" \
  "$OUT/default.yaml" "$OUT/full.yaml"

echo "== invariants on the renderings"
python3 "$ASSERT" --expect Deployment=3 --expect Job=1 --expect Service=2 --expect Ingress=2 \
  --expect NetworkPolicy=3 --expect HorizontalPodAutoscaler=0 --expect Cluster=0 --expect StatefulSet=0 \
  --expect HTTPRoute=0 --expect ServiceAccount=1 "$OUT/default.yaml"
python3 "$ASSERT" --expect Deployment=3 --expect Job=1 --expect Service=3 --expect Ingress=2 \
  --expect NetworkPolicy=4 --expect HorizontalPodAutoscaler=2 --expect Cluster=1 --expect StatefulSet=1 \
  --expect HTTPRoute=1 --expect ServiceAccount=1 "$OUT/full.yaml"

echo "== failing controls"
expect_failure() {
  # usage: expect_failure <label> <needle-in-output> -- <command...>
  local label=$1 needle=$2; shift 3
  if "$@" > "$OUT/control.out" 2>&1; then
    echo "control failed: $label succeeded but must fail" >&2; cat "$OUT/control.out" >&2; return 1
  fi
  grep -q -- "$needle" "$OUT/control.out" || { echo "control failed: $label failed without mentioning '$needle'" >&2; cat "$OUT/control.out" >&2; return 1; }
  echo "ok: $label rejected ($needle)"
}
# values that set TRUST_PROXY to `true`, `/0` or a bare address are refused by the schema and the template
expect_failure "trustedProxyCidrs=true" trustedProxyCidrs -- helm template our-stream "$CHART" --set 'api.trustedProxyCidrs={true}'
expect_failure "trustedProxyCidrs=0.0.0.0/0" trustedProxyCidrs -- helm template our-stream "$CHART" --set 'api.trustedProxyCidrs={0.0.0.0/0}'
expect_failure "trustedProxyCidrs=10.0.0.1" trustedProxyCidrs -- helm template our-stream "$CHART" --set 'api.trustedProxyCidrs={10.0.0.1}'
expect_failure "api.env.SESSION_SECRET" SESSION_SECRET -- helm template our-stream "$CHART" --set 'api.env.SESSION_SECRET=x'
expect_failure "scratch below 2x max input" scratch -- helm template our-stream "$CHART" --set 'worker.scratch.sizeLimit=1Gi'
# a rendering that violates the invariants is rejected for each reason it violates
for needle in privileged hostNetwork DATABASE_ADMIN_URL TRUST_PROXY runAsNonRoot 'development secret' envFrom 'expected 1 x Job'; do
  expect_failure "bad-rendered.yaml ($needle)" "$needle" -- python3 "$ASSERT" --expect Deployment=1 --expect Job=1 "$CHART/ci/fixtures/bad-rendered.yaml"
done
# an unknown field is rejected by kubeconform -strict
expect_failure "bad-schema.yaml" portz -- kubeconform -strict -kubernetes-version "$K8S_VERSION" -schema-location default "$CHART/ci/fixtures/bad-schema.yaml"
# an appVersion that drifts from package.json is rejected
cp -R "$CHART" "$OUT/drift" && sed -i.bak "s/^appVersion: .*/appVersion: '9.9.9'/" "$OUT/drift/Chart.yaml"
expect_failure "appVersion drift" "!= package.json" -- check_app_version "$OUT/drift"
echo "chart checks passed"
