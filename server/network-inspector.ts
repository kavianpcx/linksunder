import { lookup, reverse, resolve4, resolve6, resolveCname, resolveMx, resolveNs } from 'node:dns/promises';
import { connect as connectTcp, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type {
  DnsSummary,
  HttpCheck,
  NetworkFinding,
  NetworkInspectionRequest,
  NetworkPortStatus,
  NetworkReport,
  PortResult,
  TlsSummary,
} from '../shared/network.js';

const DNS_TIMEOUT_MS = 1800;
const MAX_REDIRECTS = 5;
const MAX_CONCURRENT_PORTS = 4;
const SECURITY_HEADERS = [
  ['Strict-Transport-Security', 'strict-transport-security'],
  ['Content-Security-Policy', 'content-security-policy'],
  ['X-Frame-Options', 'x-frame-options'],
  ['X-Content-Type-Options', 'x-content-type-options'],
  ['Referrer-Policy', 'referrer-policy'],
  ['Permissions-Policy', 'permissions-policy'],
] as const;
const LIMITATIONS = [
  'Port results show whether a TCP connection was accepted; an open port is not, by itself, a vulnerability.',
  'Timeouts are reported as unknown because a filtered service cannot be distinguished from a slow or unreachable host.',
  'HTTP checks send HEAD requests only, follow at most five redirects on the same hostname, and never store response bodies or cookie values.',
  'TLS inspection observes the certificate handshake; it does not perform a full cryptographic or vulnerability assessment.',
  'This inspector does not exploit services, authenticate, brute-force, or scan address ranges.',
];

export interface NormalizedTarget {
  hostname: string;
  hostForUrl: string;
  target: string;
  pathname: string;
  port?: number;
  explicitScheme: boolean;
  scheme: 'http' | 'https';
}

export function normalizeNetworkTarget(raw: string): NormalizedTarget {
  const input = raw.trim();
  if (!input || input.length > 500 || [...input].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error('Enter a domain, IP address, or HTTP(S) URL.');

  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  let candidate = input;
  if (!explicitScheme) {
    candidate = isIP(input) === 6 ? `https://[${input}]` : `https://${input}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Enter a valid domain, IPv4/IPv6 address, or HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP(S) targets without embedded usernames or passwords are allowed.');

  const authority = input.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0] || '';
  const suppliedPort = isIP(input) === 6
    ? undefined
    : authority.startsWith('[')
      ? /^\[[^\]]+\]:(\d+)$/.exec(authority)?.[1]
      : /:(\d+)$/.exec(authority)?.[1];
  const port = url.port ? Number(url.port) : suppliedPort ? Number(suppliedPort) : undefined;
  if (!explicitScheme && port !== undefined)
    url.protocol = port === 443 || port === 8443 ? 'https:' : 'http:';

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const domainName = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (!hostname || hostname.length > 253 || (isIP(hostname) === 0 && domainName.split('.').some((label) =>
    label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  )))
    throw new Error('Enter a valid domain name or IP address.');

  // Never retain query parameters or fragments in a report or send them to the target.
  url.search = '';
  url.hash = '';
  const hostForUrl = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const target = `${url.protocol}//${url.host}${url.pathname || '/'}`;
  return {
    hostname,
    hostForUrl,
    target,
    pathname: url.pathname || '/',
    port,
    explicitScheme,
    scheme: url.protocol === 'https:' ? 'https' : 'http',
  };
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, fallback: T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(fallback);
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    if (signal?.aborted) {
      finish(fallback);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(finish, () => finish(fallback));
  });
}

async function dnsSummary(
  hostname: string,
  onProgress: (progress: string) => void,
  signal: AbortSignal,
): Promise<DnsSummary> {
  const started = Date.now();
  const ipVersion = isIP(hostname);
  if (ipVersion) {
    const names = await withTimeout(() => reverse(hostname), DNS_TIMEOUT_MS, [] as string[], signal);
    return {
      A: ipVersion === 4 ? [hostname] : [],
      AAAA: ipVersion === 6 ? [hostname] : [],
      CNAME: [],
      NS: [],
      MX: [],
      reverse: names.length ? [{ address: hostname, names }] : [],
      lookupTimeMs: Date.now() - started,
      note: 'The target is an IP address; DNS record queries were not needed.',
    };
  }

  onProgress('Looking up DNS records…');
  const [A, AAAA, CNAME, NS, MX, addresses] = await Promise.all([
    withTimeout(() => resolve4(hostname), DNS_TIMEOUT_MS, [] as string[], signal),
    withTimeout(() => resolve6(hostname), DNS_TIMEOUT_MS, [] as string[], signal),
    withTimeout(() => resolveCname(hostname), DNS_TIMEOUT_MS, [] as string[], signal),
    withTimeout(() => resolveNs(hostname), DNS_TIMEOUT_MS, [] as string[], signal),
    withTimeout(() => resolveMx(hostname), DNS_TIMEOUT_MS, [] as Array<{ exchange: string; priority: number }>, signal),
    withTimeout(() => lookup(hostname, { all: true, verbatim: true }), DNS_TIMEOUT_MS, [] as Array<{ address: string; family: number }>, signal),
  ]);
  const uniqueAddresses = [...new Set([...A, ...AAAA, ...addresses.map((entry) => entry.address)])].slice(0, 16);
  const reverseResults = await Promise.all(
    uniqueAddresses.slice(0, 3).map(async (address) => ({
      address,
      names: await withTimeout(() => reverse(address), DNS_TIMEOUT_MS, [] as string[], signal),
    })),
  );
  return {
    A: [...new Set(A)].slice(0, 16),
    AAAA: [...new Set(AAAA)].slice(0, 16),
    CNAME: [...new Set(CNAME)].slice(0, 16),
    NS: [...new Set(NS)].slice(0, 16),
    MX: MX.slice(0, 16).map(({ exchange, priority }) => ({ exchange, priority })),
    reverse: reverseResults.filter((item) => item.names.length > 0),
    lookupTimeMs: Date.now() - started,
    note: uniqueAddresses.length ? undefined : 'No A or AAAA records were returned by the system DNS resolver.',
  };
}

export function classifyPortError(code?: string): NetworkPortStatus {
  if (code === 'ECONNREFUSED') return 'CLOSED';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL')
    return 'UNKNOWN';
  return 'ERROR';
}

function checkPort(hostname: string, port: number, timeout: number, signal: AbortSignal): Promise<PortResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = connectTcp({ host: hostname, port });
    const finish = (status: NetworkPortStatus, note?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve({ port, protocol: 'TCP', status, durationMs: Date.now() - started, note });
    };
    const onAbort = () => finish('UNKNOWN', 'Cancelled before the connection completed.');
    socket.setTimeout(timeout);
    socket.once('connect', () => finish('OPEN', 'TCP connection accepted.'));
    socket.once('timeout', () => finish('UNKNOWN', `No response within ${timeout} ms.`));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const status = classifyPortError(error.code);
      const note =
        status === 'CLOSED'
          ? 'The target refused the TCP connection.'
          : status === 'UNKNOWN'
            ? 'The target did not respond or could not be reached.'
            : 'The operating system could not complete this TCP check.';
      finish(status, note);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function inspectPorts(
  hostname: string,
  ports: number[],
  timeout: number,
  signal: AbortSignal,
  onProgress: (progress: string) => void,
): Promise<PortResult[]> {
  const results = new Array<PortResult>(ports.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < ports.length) {
      const index = nextIndex++;
      onProgress(`Checking TCP port ${ports[index]} (${index + 1} of ${ports.length})…`);
      results[index] = await checkPort(hostname, ports[index], timeout, signal);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_PORTS, ports.length) }, () => worker()),
  );
  return results;
}

function cleanUrl(url: URL): string {
  const result = new URL(url);
  result.search = '';
  result.hash = '';
  return result.toString();
}

function headerSummary(name: string, value: string | null): { present: boolean; summary?: string } {
  if (!value) return { present: false };
  if (name === 'Strict-Transport-Security') {
    const maxAge = value.match(/max-age\s*=\s*\d+/i)?.[0];
    const subdomains = /includeSubDomains/i.test(value) ? 'includeSubDomains' : undefined;
    const preload = /preload/i.test(value) ? 'preload' : undefined;
    return { present: true, summary: [maxAge, subdomains, preload].filter(Boolean).join('; ') };
  }
  return { present: true };
}

function cookieFlags(headers: Headers): HttpCheck['cookieFlags'] {
  const getSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = getSetCookie.getSetCookie?.() ?? [];
  return values.slice(0, 20).map((value) => ({
    secure: /(?:^|;)\s*secure\s*(?:;|$)/i.test(value),
    httpOnly: /(?:^|;)\s*httponly\s*(?:;|$)/i.test(value),
    sameSite: value.match(/(?:^|;)\s*samesite\s*=\s*(lax|strict|none)/i)?.[1]?.toLowerCase(),
  }));
}

async function inspectHttp(
  base: NormalizedTarget,
  scheme: 'http' | 'https',
  timeout: number,
  signal: AbortSignal,
): Promise<HttpCheck> {
  const port = base.port ? `:${base.port}` : '';
  let current = new URL(`${scheme}://${base.hostForUrl}${port}${base.pathname}`);
  const check: HttpCheck = {
    scheme,
    redirectChain: [],
    securityHeaders: Object.fromEntries(SECURITY_HEADERS.map(([name]) => [name, { present: false }])),
    cookieFlags: [],
  };
  const initialHost = base.hostname;
  const started = Date.now();

  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    try {
      const signalWithTimeout = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
      const response = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: signalWithTimeout,
        headers: { 'user-agent': 'LinkSunder Network Inspector', accept: '*/*' },
      });
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        const next = new URL(location, current);
        if (next.username || next.password) {
          check.error = 'Stopped at a redirect containing embedded credentials.';
          break;
        }
        check.redirectChain.push(`${response.status} ${cleanUrl(next)}`);
        if (!['http:', 'https:'].includes(next.protocol)) {
          check.error = 'Redirect uses a protocol that is not supported.';
          break;
        }
        if (next.hostname.toLowerCase() !== initialHost) {
          check.error = 'Stopped at a redirect to a different hostname.';
          check.finalUrl = cleanUrl(next);
          break;
        }
        if (index === MAX_REDIRECTS) {
          check.error = `Stopped after ${MAX_REDIRECTS} redirects.`;
          break;
        }
        current = next;
        continue;
      }

      check.status = response.status;
      check.finalUrl = cleanUrl(current);
      check.contentType = response.headers.get('content-type')?.slice(0, 160);
      check.server = response.headers.get('server')?.slice(0, 160);
      check.contentEncoding = response.headers.get('content-encoding')?.slice(0, 80);
      check.cookieFlags = cookieFlags(response.headers);
      check.securityHeaders = Object.fromEntries(
        SECURITY_HEADERS.map(([name, key]) => [key, headerSummary(name, response.headers.get(key))]),
      );
      check.redirectsToHttps = scheme === 'http' && current.protocol === 'https:';
      await response.body?.cancel();
      break;
    } catch (error) {
      check.error = signal.aborted
        ? 'Cancelled.'
        : error instanceof Error && error.name === 'TimeoutError'
          ? `No HTTP response within ${timeout} ms.`
          : 'The HTTP check could not complete. The endpoint may be unavailable or require a valid TLS certificate.';
      break;
    }
  }
  check.responseTimeMs = Date.now() - started;
  return check;
}

function tlsErrorMessage(error: NodeJS.ErrnoException): string {
  if (error.code === 'ETIMEDOUT') return 'TLS handshake timed out.';
  if (error.code === 'ECONNREFUSED') return 'The target refused the TLS connection.';
  return 'A TLS certificate could not be read from this port.';
}

export function summarizeTlsCertificate(certificate: {
  subject?: Record<string, string | string[] | undefined>;
  issuer?: Record<string, string | string[] | undefined>;
  valid_from?: string;
  valid_to?: string;
  subjectaltname?: string;
  fingerprint256?: string;
  protocol?: string;
  authorized?: boolean;
  authorizationError?: string | Error | null;
}, port: number): TlsSummary {
  const validToTime = certificate.valid_to ? Date.parse(certificate.valid_to) : NaN;
  const daysUntilExpiry = Number.isFinite(validToTime)
    ? Math.floor((validToTime - Date.now()) / 86_400_000)
    : undefined;
  const subject = certificate.subject ? JSON.stringify(certificate.subject) : undefined;
  const issuer = certificate.issuer ? JSON.stringify(certificate.issuer) : undefined;
  const authorizationError = typeof certificate.authorizationError === 'string'
    ? certificate.authorizationError
    : certificate.authorizationError instanceof Error
      ? String((certificate.authorizationError as Error & { code?: string }).code || certificate.authorizationError.message)
      : '';
  const selfSigned = Boolean(subject && issuer && subject === issuer) ||
    authorizationError.includes('SELF_SIGNED');
  return {
    port,
    subject,
    issuer,
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    daysUntilExpiry,
    subjectAltNames: (certificate.subjectaltname?.split(/,\s*/).map((name) => name.replace(/^(?:DNS|IP Address):\s*/i, '')).filter(Boolean) ?? []).slice(0, 40),
    fingerprint256: certificate.fingerprint256,
    protocol: certificate.protocol,
    selfSigned,
    hostnameMismatch: authorizationError === 'ERR_TLS_CERT_ALTNAME_INVALID',
    authorized: certificate.authorized,
  };
}

function inspectTls(hostname: string, port: number, timeout: number, signal: AbortSignal): Promise<TlsSummary> {
  return new Promise((resolve) => {
    let settled = false;
    const hostForSni = isIP(hostname) ? undefined : hostname;
    const socket = connectTls({ host: hostname, port, servername: hostForSni, rejectUnauthorized: false });
    const finish = (result: TlsSummary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ port, subjectAltNames: [], error: 'TLS handshake timed out.' }), timeout);
    const onAbort = () => finish({ port, subjectAltNames: [], error: 'Cancelled.' });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      if (!certificate || !Object.keys(certificate).length) {
        finish({ port, subjectAltNames: [], error: 'The endpoint did not provide a certificate.' });
        return;
      }
      finish(summarizeTlsCertificate({
        subject: certificate.subject,
        issuer: certificate.issuer,
        valid_from: certificate.valid_from,
        valid_to: certificate.valid_to,
        subjectaltname: certificate.subjectaltname,
        fingerprint256: certificate.fingerprint256,
        protocol: socket.getProtocol() ?? undefined,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError,
      }, port));
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish({ port, subjectAltNames: [], error: tlsErrorMessage(error) }),
    );
    socket.once('timeout', () => finish({ port, subjectAltNames: [], error: 'TLS handshake timed out.' }));
    socket.setTimeout(timeout);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function buildNetworkFindings(
  ports: PortResult[],
  http: HttpCheck[],
  tls?: TlsSummary,
): NetworkFinding[] {
  const findings: NetworkFinding[] = [];
  const open = ports.filter((port) => port.status === 'OPEN');
  if (open.length) {
    findings.push({
      severity: 'Info',
      title: 'TCP services accepted a connection',
      detail: `Ports ${open.map((port) => port.port).join(', ')} accepted a TCP connection. This describes reachability only and does not establish a vulnerability.`,
    });
  }
  for (const port of open.filter((item) => [21, 3306, 5432, 6379, 27017].includes(item.port))) {
    findings.push({
      severity: 'Medium',
      title: `Review access to TCP port ${port.port}`,
      detail: `A service accepted a connection on port ${port.port}. An open port is not automatically a vulnerability; confirm it is intentionally reachable and protected by your network controls.`,
    });
  }
  if (ports.some((port) => port.status === 'UNKNOWN')) {
    findings.push({
      severity: 'Info',
      title: 'Some port results are unknown',
      detail: 'A timeout or routing problem can hide whether a service is open or closed. Try a longer timeout or check the target network path.',
    });
  }

  const httpResult = http.find((item) => item.scheme === 'http' && item.status !== undefined);
  const httpsResult = http.find((item) => item.scheme === 'https' && item.status !== undefined);
  if (httpResult && httpsResult && !httpResult.redirectsToHttps) {
    findings.push({
      severity: 'Medium',
      title: 'HTTP does not redirect to HTTPS',
      detail: 'The HTTP endpoint responded without redirecting to HTTPS. Consider redirecting visitors to the encrypted endpoint.',
    });
  }
  if (httpsResult) {
    const headers = httpsResult.securityHeaders;
    if (!headers['strict-transport-security']?.present) {
      findings.push({
        severity: 'Low',
        title: 'HSTS header was not detected',
        detail: 'Browsers may continue to use HTTP unless users arrive at HTTPS first. Consider a carefully tested Strict-Transport-Security policy.',
      });
    }
    if (!headers['content-security-policy']?.present) {
      findings.push({
        severity: 'Low',
        title: 'Content Security Policy was not detected',
        detail: 'A Content-Security-Policy can reduce the impact of some content injection bugs. Start with a report-only policy if you are unsure.',
      });
    }
  }
  if (tls) {
    if (tls.hostnameMismatch) {
      findings.push({ severity: 'High', title: 'Certificate hostname mismatch', detail: 'The certificate name does not match the inspected hostname. Check the certificate and server configuration.' });
    }
    if (tls.selfSigned) {
      findings.push({ severity: 'Medium', title: 'Self-signed TLS certificate detected', detail: 'Browsers and clients will not trust this certificate by default. Use a certificate trusted by your intended clients.' });
    }
    if (tls.daysUntilExpiry !== undefined && tls.daysUntilExpiry < 0) {
      findings.push({ severity: 'High', title: 'TLS certificate has expired', detail: 'The certificate validity period ended. Renew it and verify the server presents the renewed certificate.' });
    } else if (tls.daysUntilExpiry !== undefined && tls.daysUntilExpiry <= 30) {
      findings.push({ severity: 'Medium', title: 'TLS certificate expires soon', detail: `The certificate expires in ${tls.daysUntilExpiry} day(s). Plan a renewal before it expires.` });
    }
  }
  if (!findings.length) {
    findings.push({ severity: 'Info', title: 'No notable findings from these checks', detail: 'This limited overview does not replace a full configuration review or security assessment.' });
  }
  return findings;
}

export async function inspectNetworkTarget(
  request: NetworkInspectionRequest,
  id: string,
  signal: AbortSignal,
  onProgress: (progress: string) => void = () => undefined,
): Promise<NetworkReport> {
  const target = normalizeNetworkTarget(request.target);
  const report: NetworkReport = {
    id,
    kind: 'network',
    target: target.target,
    hostname: target.hostname,
    started: new Date().toISOString(),
    status: 'running',
    progress: 'Preparing checks…',
    dns: { A: [], AAAA: [], CNAME: [], NS: [], MX: [], reverse: [], lookupTimeMs: 0 },
    ports: [],
    http: [],
    findings: [],
    limitations: [...LIMITATIONS],
  };
  const progress = (message: string) => {
    report.progress = message;
    onProgress(message);
  };

  try {
    report.dns = await dnsSummary(target.hostname, progress, signal);
    if (!signal.aborted) {
      report.ports = await inspectPorts(target.hostname, request.ports, request.timeout, signal, progress);
    }
    if (!signal.aborted) {
      const schemes: Array<'http' | 'https'> = target.explicitScheme
        ? [target.scheme]
        : target.port
          ? [target.port === 443 || target.port === 8443 ? 'https' : 'http']
          : ['http', 'https'];
      report.http = [];
      for (const scheme of schemes) {
        progress(`Checking ${scheme.toUpperCase()} response headers…`);
        report.http.push(await inspectHttp(target, scheme, request.timeout, signal));
        if (signal.aborted) break;
      }
    }
    if (!signal.aborted) {
      const tlsPort = target.scheme === 'https' && target.port &&
        (target.explicitScheme || target.port === 443 || target.port === 8443)
        ? target.port
        : request.ports.includes(443)
          ? 443
          : request.ports.includes(8443)
            ? 8443
            : undefined;
      if (tlsPort) {
        progress(`Reading the TLS certificate on port ${tlsPort}…`);
        report.tls = await inspectTls(target.hostname, tlsPort, request.timeout, signal);
      }
    }
    report.status = signal.aborted ? 'cancelled' : 'complete';
    report.error = signal.aborted ? 'Inspection cancelled. Completed observations are preserved.' : undefined;
    report.progress = signal.aborted ? 'Cancelled' : 'Complete';
    report.findings = buildNetworkFindings(report.ports, report.http, report.tls);
  } catch (error) {
    report.status = signal.aborted ? 'cancelled' : 'error';
    report.error = signal.aborted ? 'Inspection cancelled.' : (error as Error).message;
    report.progress = signal.aborted ? 'Cancelled' : 'Stopped';
    report.findings = buildNetworkFindings(report.ports, report.http, report.tls);
  }
  report.completed = new Date().toISOString();
  return report;
}
