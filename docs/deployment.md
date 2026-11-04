# Deployment

Two supported shapes: Docker Compose for evaluation and small installs, and the Helm chart under
`infra/helm/our-stream` for Kubernetes. Both run the same three images (api, web, worker) built from
`infra/docker/*.Dockerfile`, both run migrations as the schema-owning admin role before the application
starts, and both put a reverse proxy that sets `X-Forwarded-For` in front of the application so the API's
per-address budgets see real client addresses. This page describes what each shape does today; the roadmap
(`docs/roadmap.md`) lists what it does not yet do.

## Trust chain for client addresses

The API keys its unauthenticated and sign-in budgets by `req.ip` (`docs/development.md`, "Proxies and rate
limits"). Fastify derives `req.ip` from `X-Forwarded-For` only for hops listed in `TRUST_PROXY`, walking the
header from the right and stopping at the first untrusted address. The chain is sound when every trusted hop
sets the header itself, and no untrusted party can reach a trusted hop's upstream directly.

- The web app (Next.js) is never a trusted hop. Its `/api` and `/media` rewrites forward `X-Forwarded-For`
  exactly as received, so trusting it would let any client pick its own address. Both shapes therefore
  route `/api/*` and `/media/*` to the API at the proxy and send only pages to web.
- `TRUST_PROXY` is always a CIDR list, never `true`, `uniquelocal` or a hop count. The chart's schema and
  template refuse anything else, including `/0` and prefixes broader than `/8` (IPv4) or `/16` (IPv6).
- The proxy discards client-supplied `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `X-Forwarded-Host` and
  `X-Forwarded-Proto`, and sets the first two from the connection. Caddy does this when its
  `trusted_proxies` list is empty (the compose default); ingress-nginx does it unless
  `use-forwarded-headers` is on. If an outer proxy or CDN sits in front, configure the edge to trust that
  outer hop (Caddy `trusted_proxies`, ingress `use-forwarded-headers` plus `proxy-real-ip-cidr`), not the
  API.
- Address-based budgets are per API process. Several API replicas multiply them; the chart warns when
  `api.replicaCount` is above one. A shared store is scheduled with multi-instance deployments (ADR-0004).
- IPv6 clients behind an IPv4-only trusted list fall back to the proxy's address (a shared bucket, no
  spoofing). List the proxy's IPv6 range too if it has one.

## Docker Compose

```sh
docker compose -f infra/docker/docker-compose.yml up --build
# app http://localhost:3000 (edge), api http://localhost:4000/health, mail http://localhost:8025, S3 http://localhost:8333
```

Services: `edge` (Caddy 2.11, the one origin browsers use), `web`, `api`, `worker`, `migrate` (runs once
as `ourstream_admin`, then the API starts), `postgres` (pgvector), `storage` (SeaweedFS S3 gateway),
`mailcatcher` (Mailpit) and the optional `whisper` profile. The edge, api, Postgres, S3 and Mailpit publish
loopback ports; `web` publishes none and is reachable only through the edge.

Networks: `edge` (edge, web, api) has a fixed subnet so the edge can hold the static address the API trusts
(`TRUST_PROXY=${EDGE_ADDRESS}/32`); `backend` carries everything else. Web and api take dynamic addresses
from `EDGE_IP_RANGE`, the edge sits outside that range, and the gateway is fixed because Docker would
otherwise choose one and it is the source address of host-published-port traffic.

| Variable                                                                                                                                | Default             | Purpose                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `WEB_PORT`                                                                                                                              | `3000`              | Host port of the edge (the app origin); `APP_BASE_URL` follows it                                  |
| `API_PORT`                                                                                                                              | `4000`              | Host port of the api, for tooling and the mobile app                                               |
| `BIND_ADDR`                                                                                                                             | `127.0.0.1`         | Bind address of the edge and api host ports                                                        |
| `EDGE_SUBNET`                                                                                                                           | `10.228.0.0/24`     | Subnet of the `edge` network; change it to run two stacks on one host                              |
| `EDGE_GATEWAY`                                                                                                                          | `10.228.0.1`        | Gateway of the `edge` network                                                                      |
| `EDGE_IP_RANGE`                                                                                                                         | `10.228.0.0/25`     | Dynamic range for web and api                                                                      |
| `EDGE_ADDRESS`                                                                                                                          | `10.228.0.254`      | Static edge address; `TRUST_PROXY` is `${EDGE_ADDRESS}/32`                                         |
| `S3_CORS_ORIGINS`                                                                                                                       | (from APP_BASE_URL) | Browser origins allowed to upload parts directly                                                   |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `PLATFORM_DB_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `SESSION_SECRET`, `MEDIA_HMAC_SECRET` | dev-only values     | Override all of them for anything but local evaluation; the API refuses the defaults in production |

TLS: the compose edge serves plain HTTP on a loopback port and does not terminate TLS; a public install
belongs on Kubernetes (Ingress TLS below). Running compose with `NODE_ENV=production` is possible (the API
then refuses every dev-only secret and requires an https `APP_BASE_URL`), but putting a TLS terminator in
front of the edge needs that terminator to set `X-Forwarded-For` and Caddy to trust it
(`trusted_proxies`), which this file does not configure.

Verified on the evaluation stack (dev2, 2026-11-04): a request through the edge with
`X-Forwarded-For: 203.0.113.9` is logged by the API with the host's address; the same header sent straight
to the api host port, straight to the web container or straight to the api container is ignored; two
`X-Forwarded-For` headers, a value naming the edge itself, `Forwarded` and `X-Real-IP` are all discarded;
one client spending `AUTH_RATE_LIMIT_MAX` gets 429 while a second client on another address still gets 401;
and the same probe with a deliberately misconfigured `TRUST_PROXY=true` never reaches 429.

Browser uploads: presigned upload-part URLs are signed against `S3_PUBLIC_ENDPOINT`
(`http://localhost:${S3_PORT}` in compose, the storage service's loopback port), while api and worker keep
using the internal `S3_ENDPOINT`. There is deliberately no `/storage` route on the edge: SigV4 signs the
request path, so a prefix-stripping hop would invalidate every presigned URL.

## Kubernetes (Helm)

```sh
helm lint infra/helm/our-stream
helm template our-stream infra/helm/our-stream -f my-values.yaml | less
helm upgrade --install our-stream infra/helm/our-stream -n our-stream --create-namespace -f my-values.yaml --timeout 20m
```

`--timeout` must cover the migrate hook: it waits up to `migrate.waitForDatabaseSeconds` for the database and
then runs the migrations (`migrate.activeDeadlineSeconds`).

Prerequisites: images for api, web and worker pushed to a registry you control (no public images are
published yet; `image.registry`/`image.repository`/`image.tag`), Postgres 17 with pgvector, S3-compatible
object storage reachable by browsers as well as pods, an ingress controller or a Gateway API implementation,
and a CNI that enforces NetworkPolicy. Kubernetes 1.29 or newer.

What the chart deploys:

- Deployments `api`, `web`, `worker` with requests/limits, non-root pods (`runAsNonRoot`, uid 1000,
  seccomp `RuntimeDefault`, all capabilities dropped, no privilege escalation, read-only root filesystem
  with emptyDirs for `/tmp`, the web `.next/cache` and the worker scratch space). Probes: api readiness
  `GET /health` (database-dependent) and TCP liveness; web `GET /sign-in`; worker startup and liveness on
  its `GET /health` (`WORKER_HEALTH_PORT` 4001, bound to all interfaces with `HOST=0.0.0.0`; 200 while
  pg-boss is up and the outbox drains, 503 otherwise).
- A `migrate` Job (`node dist/cli.js migrate` from the api image) as a `pre-install,pre-upgrade` hook
  (`post-install,pre-upgrade` when the chart renders the CloudNativePG cluster, which does not exist before
  install; the api is then Ready against an empty schema until the hook finishes). It is the only workload
  that receives `DATABASE_ADMIN_URL`, waits for the database port, and runs with the namespace's default
  ServiceAccount because hooks run before the chart's own ServiceAccount exists.
  Migrations are forward-only: `helm rollback` restores the previous images, not the schema, so follow the
  expand/contract rule in ADR-0012.
- Services for api and web; an Ingress sending `/media` to the api and everything else to web, plus a second
  Ingress for `/api` with a prefix-stripping rewrite (ingress-nginx annotations by default, overridable), or
  a Gateway API `HTTPRoute` with a standard `URLRewrite` (`gatewayApi.enabled`).
- NetworkPolicy (on by default): default-deny ingress for the release's pods; web and api reachable only
  from the ingress controller namespace (`networkPolicy.ingressNamespaceSelector`, required to be
  non-empty). Web is deliberately not allowed to reach the api: its build-time rewrites forward
  `X-Forwarded-For` unchanged, so if a controller ever routed `/api` to web (for example one that treats the
  ingress-nginx regex path literally), the request fails instead of arriving from inside the trusted range
  with a forged header. The web image defaults its `WEB_PROXY_API` build arg to `false`, so it carries no `/api` or `/media` rewrite at all and a misrouted request fails closed at web (only an edge-less image is built with `--build-arg WEB_PROXY_API=true`). The template also refuses a values file with no `/api` route to the api or a web
  path under `/api` or `/media`. Egress is not restricted.
- Optional HPAs for api and web, off by default. Leave the api at one replica until budgets have a shared
  store.
- Optional in-cluster dependencies for evaluation: a CloudNativePG `Cluster` (operator required; the image
  must ship pgvector) with the three roles from `infra/docker/postgres/init/01-roles.sh`; the operator
  generates the owner credentials in `<fullname>-pg-app` (key `uri`), which is what `secrets.migrate`
  points at, and the two application roles take passwords from Secrets you create. Also a single-pod
  SeaweedFS StatefulSet. Production installs use external Postgres and object storage. Neither has been
  exercised against a live operator in this repository.

Secrets are referenced, never written in values:

| Secret (`secrets.*.existingSecret`) | Keys                                                                                                                                  | Consumers                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `app`                               | `DATABASE_URL`, `DATABASE_PLATFORM_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `SESSION_SECRET`, `MEDIA_HMAC_SECRET`, optional `SMTP_URL` | api (not the platform URL), worker (no session secrets) |
| `migrate`                           | `key` (default `DATABASE_ADMIN_URL`; with CloudNativePG use the operator's `<fullname>-pg-app` Secret and key `uri`)                  | migrate Job only                                        |

Each workload gets explicit `secretKeyRef`s, so extra keys in a Secret never reach a pod that does not
need them. `api.env` and `worker.env` refuse credential names.

`api.trustedProxyCidrs` is `TRUST_PROXY`. Set it to the address range of the ingress controller pods; with
`/api` and `/media` routed at the ingress, the controller is the api's TCP peer. If that range is the shared
pod CIDR it also contains the web pods, which is acceptable only because web cannot reach the api
(NetworkPolicy) and never receives `/api` or `/media` (template checks); a dedicated address pool or a
host-network controller removes even that dependency. The chart refuses `true`, `/0`, prefixes broader
than `/8` (IPv4) or `/16` (IPv6) and IPv4-mapped IPv6 ranges, renders `TRUST_PROXY=false` and warns when
the list is empty. Make sure the controller does not trust client-supplied headers (ingress-nginx
`use-forwarded-headers=false`, the default). The default `/api` rewrite annotations are ingress-nginx's;
other controllers need their own (`ingress.api`) or the Gateway API route.

Residency and model providers: the worker's provider policy defaults to self-host only with zero data
retention required (`worker.providerPolicy`, ADR-0008); `worker.asr.provider` is `fake` or `whisper-http`
with `worker.asr.whisperUrl` pointing at a whisper.cpp server you run. Data residency is a property of where
you place Postgres, object storage and the cluster; the chart has no region logic (ADR-0008, roadmap M9).

Checks: `infra/helm/our-stream/ci/check.sh` runs `helm lint`, `helm template` with default and
all-options values, `kubeconform -strict` against Kubernetes 1.34 schemas and a CRD catalog, both pinned to
a commit, then asserts the rendering: expected resource counts per kind, non-root everywhere, no privileged
or host namespaces, no `envFrom`, the admin URL only in the Job, `TRUST_PROXY` as safe CIDRs, `/api` and
`/media` routed to the api and never to web, allow-policies naming a non-empty ingress namespace and never
admitting web into the api, no development secret literal (the list is read from `apps/api/src/config.ts`
and the compose defaults). Each assertion has a failing control in the script. CI runs it
(`.github/workflows/ci.yml`, job `infra`) with pinned, checksum-verified helm and kubeconform binaries,
and checks the compose trust chain on `docker compose config` output (`infra/docker/check-compose.py`:
`TRUST_PROXY` equals the edge's static address `/32`, web publishes no port, read-only workloads). The chart has not been exercised against a live cluster in
this repository; lint, schema validation and the invariants above are the evidence.
