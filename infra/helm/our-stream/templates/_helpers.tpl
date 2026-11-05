{{/* SPDX-License-Identifier: AGPL-3.0-only */}}
{{- define "our-stream.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "our-stream.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "our-stream.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "our-stream.labels" -}}
helm.sh/chart: {{ include "our-stream.chart" . }}
app.kubernetes.io/name: {{ include "our-stream.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* usage: include "our-stream.selectorLabels" (dict "root" . "component" "api") */}}
{{- define "our-stream.selectorLabels" -}}
app.kubernetes.io/name: {{ include "our-stream.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "our-stream.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "our-stream.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* usage: include "our-stream.image" (dict "root" . "component" "api") */}}
{{- define "our-stream.image" -}}
{{- $tag := default .root.Chart.AppVersion .root.Values.image.tag -}}
{{- printf "%s/%s-%s:%s" .root.Values.image.registry .root.Values.image.repository .component $tag -}}
{{- end -}}

{{- define "our-stream.apiServiceName" -}}
{{- default (printf "%s-api" (include "our-stream.fullname" .)) .Values.api.service.name -}}
{{- end -}}

{{/*
TRUST_PROXY for the api: CIDRs only, no broader than /8 (IPv4) or /16 (IPv6). `true`, `uniquelocal`,
hop counts, bare addresses and /0 would let a client pick its own address (docs/deployment.md "Trust
chain"), so refuse them here as well as in values.schema.json.
*/}}
{{- define "our-stream.trustProxy" -}}
{{- $cidrs := .Values.api.trustedProxyCidrs -}}
{{- range $cidrs -}}
{{- if or (not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([89]|[12][0-9]|3[0-2])$|^[0-9A-Fa-f:]+/(1[6-9]|[2-9][0-9]|1[01][0-9]|12[0-8])$" .)) (regexMatch "(?i)^::ffff:" .) -}}
{{- fail (printf "api.trustedProxyCidrs entries must be CIDRs no broader than /8 or /16 and not IPv4-mapped IPv6 (got %q); TRUST_PROXY=true is never allowed" .) -}}
{{- end -}}
{{- end -}}
{{- if $cidrs -}}{{ join "," $cidrs }}{{- else -}}false{{- end -}}
{{- end -}}

{{/*
usage: include "our-stream.secretEnv" (dict "secret" <name> "keys" (list ...) "optional" (list ...))
One env entry per key, so a workload sees exactly the credentials it needs even when the Secret holds more.
*/}}
{{- define "our-stream.secretEnv" -}}
{{- $secret := .secret -}}
{{- range .keys }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ . }}
{{- end }}
{{- range .optional }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ . }}
      optional: true
{{- end }}
{{- end -}}

{{/*
Worker scratch emptyDir: refuse a limit below twice the largest input (source plus transcode output), or
the kubelet evicts the pod in the middle of a job. Accepts Gi and Mi quantities.
*/}}
{{- define "our-stream.scratchSizeLimit" -}}
{{- $q := .Values.worker.scratch.sizeLimit | toString -}}
{{- $bytes := 0 -}}
{{- if hasSuffix "Gi" $q -}}{{ $bytes = mul (trimSuffix "Gi" $q | int64) 1073741824 }}
{{- else if hasSuffix "Mi" $q -}}{{ $bytes = mul (trimSuffix "Mi" $q | int64) 1048576 }}
{{- else -}}{{ fail (printf "worker.scratch.sizeLimit must be a Gi or Mi quantity (got %q)" $q) }}{{- end -}}
{{- $need := mul (.Values.worker.mediaMaxInputBytes | int64) 2 -}}
{{- if lt $bytes $need -}}
{{- fail (printf "worker.scratch.sizeLimit (%s) must be at least 2 x worker.mediaMaxInputBytes (%d bytes)" $q $need) -}}
{{- end -}}
{{ $q }}
{{- end -}}

{{- define "our-stream.s3CorsOrigins" -}}
{{- if .Values.objectStorage.corsOrigins -}}{{ join "," .Values.objectStorage.corsOrigins }}{{- else -}}{{ .Values.appBaseUrl }}{{- end -}}
{{- end -}}

{{/* Non-secret object storage environment shared by api and worker. */}}
{{- define "our-stream.objectStorageEnv" -}}
- name: S3_ENDPOINT
  value: {{ .Values.objectStorage.endpoint | quote }}
- name: S3_REGION
  value: {{ .Values.objectStorage.region | quote }}
- name: S3_BUCKET
  value: {{ .Values.objectStorage.bucket | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ .Values.objectStorage.forcePathStyle | toString | quote }}
{{- end -}}

{{/* usage: include "our-stream.extraEnv" .Values.api.env */}}
{{- define "our-stream.extraEnv" -}}
{{- range $k, $v := . }}
- name: {{ $k }}
  value: {{ $v | toString | quote }}
{{- end }}
{{- end -}}

{{/* Name of the claim shared by worker and parser (slot and ctl subPaths). */}}
{{- define "our-stream.parserIoClaim" -}}
{{- default (printf "%s-parser-io" (include "our-stream.fullname" .)) .Values.parser.io.existingClaim -}}
{{- end -}}
