// SPDX-License-Identifier: Apache-2.0
// Server discovery by email domain (decision Q5). The organisation publishes
// https://<email domain>/.well-known/our-stream.json = {"version":1,"apiUrl":"https://...","webUrl":"https://..."}.
// Trust rules: only that exact https URL is fetched, redirects are not followed (a document served
// from any other host is refused), the body is capped and the request times out. The resolved server
// is shown to the user and confirmed before the first sign-in, then pinned (session.ts).

export const DISCOVERY_PATH = '/.well-known/our-stream.json';
export const DISCOVERY_MAX_BYTES = 16 * 1024;
export const DISCOVERY_TIMEOUT_MS = 8_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServerConfig {
  /** Base URL of the API (`/v1/...` and `/media/...` live under it), no trailing slash. */
  apiUrl: string;
  /** Web origin used for share links (`linkPath` is appended), no trailing slash. */
  webUrl: string;
}

export type DiscoveryFailure =
  | 'bad_email'
  | 'unreachable'
  | 'timeout'
  | 'not_found'
  | 'redirected'
  | 'too_large'
  | 'invalid'
  | 'insecure_server';

export type DiscoveryResult =
  { ok: true; domain: string; server: ServerConfig } | { ok: false; reason: DiscoveryFailure };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_TLDS = new Set([
  'local',
  'internal',
  'localhost',
  'test',
  'invalid',
  'example',
  'home',
  'lan',
  'arpa',
]);

/** The lowercased DNS domain of an email address, or null when it is not a usable host name. */
export function emailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at !== trimmed.indexOf('@')) return null;
  const host = trimmed.slice(at + 1);
  if (!host || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL.test(l))) return null;
  // IPv4 literals are host names syntactically; a discovery document never lives on one.
  if (labels.every((l) => /^\d+$/.test(l))) return null;
  // Reserved or link-local suffixes never carry a public https document.
  if (RESERVED_TLDS.has(labels[labels.length - 1] ?? '')) return null;
  return host;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface UrlOptions {
  /** Development builds may point at a local API over plain http (never a LAN or public host). */
  allowLoopbackHttp?: boolean;
}

/**
 * Normalises a server URL for storage and display: https (or loopback http in dev), no credentials,
 * query or fragment, lowercased host, no trailing slash. Returns null for anything else.
 */
export function validateServerUrl(raw: string, opts: UrlOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (raw.includes('?') || raw.includes('#')) return null;
  if (!url.hostname) return null;
  if (url.protocol === 'http:') {
    if (!opts.allowLoopbackHttp || !LOOPBACK.has(url.hostname)) return null;
  } else if (url.protocol !== 'https:') {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/[^A-Za-z0-9._~!$&'()*+,;=:@/%-]/.test(path)) return null;
  return `${url.protocol}//${url.host}${path}`;
}

function webUrlFor(apiUrl: string): string {
  return apiUrl.endsWith('/api') ? apiUrl.slice(0, -'/api'.length) : apiUrl;
}

export function parseDiscoveryDocument(
  text: string,
  opts: UrlOptions = {},
): { ok: true; server: ServerConfig } | { ok: false; reason: 'invalid' | 'insecure_server' } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return { ok: false, reason: 'invalid' };
  const d = doc as Record<string, unknown>;
  if (d['version'] !== 1 || typeof d['apiUrl'] !== 'string')
    return { ok: false, reason: 'invalid' };
  if (d['webUrl'] !== undefined && typeof d['webUrl'] !== 'string')
    return { ok: false, reason: 'invalid' };
  const apiUrl = validateServerUrl(d['apiUrl'], opts);
  if (!apiUrl)
    return { ok: false, reason: isPlainHttp(d['apiUrl']) ? 'insecure_server' : 'invalid' };
  let webUrl = webUrlFor(apiUrl);
  if (typeof d['webUrl'] === 'string') {
    const w = validateServerUrl(d['webUrl'], opts);
    if (!w) return { ok: false, reason: isPlainHttp(d['webUrl']) ? 'insecure_server' : 'invalid' };
    webUrl = w;
  }
  return { ok: true, server: { apiUrl, webUrl } };
}

function isPlainHttp(raw: string): boolean {
  return /^\s*http:\/\//i.test(raw);
}

export interface DiscoveryDeps extends UrlOptions {
  fetch: FetchLike;
  timeoutMs?: number;
}

export async function discoverServer(email: string, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const domain = emailDomain(email);
  if (!domain) return { ok: false, reason: 'bad_email' };
  const url = `https://${domain}${DISCOVERY_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // React Native's fetch cannot stop redirects, so the response URL is checked below as well.
      redirect: 'manual',
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: isAbort(err) ? 'timeout' : 'unreachable' };
  }
  try {
    if (response.status >= 300 && response.status < 400) return { ok: false, reason: 'redirected' };
    // The document must come from exactly the URL asked for: a redirect anywhere else (or a fetch
    // that cannot tell, leaving `url` empty) is refused.
    if (response.redirected || response.url !== url) return { ok: false, reason: 'redirected' };
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (!response.ok) return { ok: false, reason: 'unreachable' };
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > DISCOVERY_MAX_BYTES) return { ok: false, reason: 'too_large' };
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      return { ok: false, reason: isAbort(err) ? 'timeout' : 'unreachable' };
    }
    if (text.length > DISCOVERY_MAX_BYTES) return { ok: false, reason: 'too_large' };
    const parsed = parseDiscoveryDocument(text, deps);
    if (!parsed.ok) return parsed;
    return { ok: true, domain, server: parsed.server };
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export type HostRelation = 'same' | 'subdomain' | 'other';

/**
 * How the discovered server host relates to the email domain. `other` is legitimate (hosted SaaS)
 * but is the main credential-theft path of Q5, so the confirm screen warns and makes cancel the
 * default action.
 */
export function hostRelation(domain: string, serverUrl: string): HostRelation {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host === domain) return 'same';
  if (host.endsWith(`.${domain}`)) return 'subdomain';
  return 'other';
}
