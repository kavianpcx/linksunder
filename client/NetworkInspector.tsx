import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Download, Globe2, LoaderCircle, LockKeyhole, Play, ShieldAlert, ShieldCheck, Square, X } from 'lucide-react';
import { COMMON_PORTS, type HttpCheck, type NetworkReport } from '../shared/network';
import { api } from './api';
import { SelectField } from './SelectField';
import { formatRunTimestamp } from './format-run-timestamp';

const PORT_PRESETS: Record<string, number[]> = {
  common: [...COMMON_PORTS],
  web: [80, 443, 8080, 8443],
  mail: [21, 22, 25, 53, 110, 143],
  data: [3306, 5432, 6379, 27017],
  custom: [80, 443],
};
const PORT_PRESET_OPTIONS = [
  { value: 'common', label: 'Common services (14 ports)' },
  { value: 'web', label: 'Web services (4 ports)' },
  { value: 'mail', label: 'Mail and access (6 ports)' },
  { value: 'data', label: 'Data services (4 ports)' },
  { value: 'custom', label: 'Custom list (up to 20)' },
];
const TIMEOUT_OPTIONS = [
  { value: '700', label: '700 ms · faster' },
  { value: '1200', label: '1.2 seconds · default' },
  { value: '2000', label: '2 seconds' },
  { value: '3000', label: '3 seconds · slower networks' },
];

interface NetworkInspectorProps {
  initialReport?: NetworkReport;
  onReportChange: (report?: NetworkReport) => void;
  onRefresh: () => Promise<void>;
  onOpenHistory: () => void;
}

function httpBadge(check: HttpCheck) {
  if (check.status === undefined) {
    if (check.error?.startsWith('No HTTP response within')) return { className: 'warn', label: 'Timed out' };
    if (check.error?.startsWith('Cancelled')) return { className: 'warn', label: 'Cancelled' };
    return { className: check.error ? 'error' : '', label: check.error ? 'Transport error' : 'Unknown' };
  }
  if (check.status >= 200 && check.status < 300) return { className: 'pass', label: `HTTP ${check.status} · success` };
  if (check.status >= 300 && check.status < 400) return { className: 'warn', label: `HTTP ${check.status} · redirect` };
  if (check.status >= 400 && check.status < 500) return { className: 'error', label: `HTTP ${check.status} · client error` };
  if (check.status >= 500 && check.status < 600) return { className: 'error', label: `HTTP ${check.status} · server error` };
  return { className: 'warn', label: `HTTP ${check.status} · informational` };
}

function validNetworkTarget(value: string) {
  const target = value.trim();
  if (!target || target.length > 500 || /\s/.test(target)) return false;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(target) ? target : `http://${target}`);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function renderHttpCheck(check: HttpCheck) {
  const badge = httpBadge(check);
  return (
    <article className="http-card" key={check.scheme}>
      <div className="http-card-head">
        <h3>{check.scheme.toUpperCase()}</h3>
        <span className={`badge ${badge.className}`} title={check.error}>{badge.label}</span>
      </div>
      <p className="mono-line">{check.finalUrl || 'No final URL recorded'} · {check.responseTimeMs ?? '—'} ms</p>
      {check.error && <p className="inline-warning">{check.error}</p>}
      <dl className="detail-grid">
        <dt>Content type</dt><dd>{check.contentType || 'Not reported'}</dd>
        <dt>Server</dt><dd>{check.server || 'Not reported'}</dd>
        <dt>Compression</dt><dd>{check.contentEncoding || 'Not reported'}</dd>
        <dt>HTTP → HTTPS</dt><dd>{check.scheme === 'http' ? (check.redirectsToHttps ? 'Redirect detected' : 'No redirect detected') : '—'}</dd>
        <dt>Redirects</dt><dd>{check.redirectChain.length ? check.redirectChain.join(' → ') : 'None'}</dd>
      </dl>
      <h4>Security response headers</h4>
      <div className="header-checks">
        {Object.entries(check.securityHeaders).map(([name, header]) => (
          <span className={header.present ? 'header-present' : 'header-missing'} key={name}>
            {header.present ? <Check size={13} /> : <X size={13} />}{name}{header.summary ? ` · ${header.summary}` : ''}
          </span>
        ))}
      </div>
      <p className="hint">Cookie flags only: {check.cookieFlags.length ? check.cookieFlags.map((cookie, index) => `Cookie ${index + 1}: Secure ${cookie.secure ? 'yes' : 'no'}, HttpOnly ${cookie.httpOnly ? 'yes' : 'no'}, SameSite ${cookie.sameSite || 'not set'}`).join(' · ') : 'No Set-Cookie headers observed.'} Values are never saved.</p>
    </article>
  );
}

export function NetworkInspector({ initialReport, onReportChange, onRefresh, onOpenHistory }: NetworkInspectorProps) {
  const [target, setTarget] = useState('');
  const [preset, setPreset] = useState('common');
  const [customPorts, setCustomPorts] = useState('80, 443');
  const [timeout, setTimeout] = useState(1200);
  const [authorized, setAuthorized] = useState(false);
  const [current, setCurrent] = useState<NetworkReport | undefined>(initialReport);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialReport) setCurrent(initialReport);
  }, [initialReport?.id]);

  useEffect(() => {
    if (!current || current.status !== 'running') return;
    let live = true;
    const poll = async () => {
      try {
        const report = await api<NetworkReport>(`/api/network/reports/${current.id}`);
        if (!live) return;
        setCurrent(report);
        onReportChange(report);
        if (report.status !== 'running') {
          cancellingRef.current = false;
          setCancelling(false);
          await onRefresh();
        }
      } catch (reason) {
        if (live) setError((reason as Error).message);
      }
    };
    const timer = window.setInterval(() => void poll(), 500);
    void poll();
    return () => { live = false; window.clearInterval(timer); };
  }, [current?.id, current?.status, onRefresh, onReportChange]);

  function selectedPorts() {
    if (preset !== 'custom') return PORT_PRESETS[preset];
    const parts = customPorts.split(',').map((value) => value.trim()).filter(Boolean);
    if (!parts.length) throw new Error('Enter one or more TCP ports, such as 80, 443.');
    const ports = parts.map(Number);
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error('Ports must be whole numbers from 1 to 65535.');
    if (new Set(ports).size !== ports.length) throw new Error('Remove duplicate port numbers.');
    if (ports.length > 20) throw new Error('Choose no more than 20 ports per check.');
    return ports;
  }

  async function startInspection(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || current?.status === 'running') return;
    setError('');
    if (!authorized) {
      setError('Confirm that you own or are authorized to inspect this system.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const report = await api<NetworkReport>('/api/network/scans', {
        target,
        ports: selectedPorts(),
        timeout,
        authorized,
      });
      setCurrent(report);
      onReportChange(report);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function cancelInspection() {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    try {
      await api('/api/network/cancel', {});
    } catch (reason) {
      cancellingRef.current = false;
      setCancelling(false);
      setError((reason as Error).message);
    }
  }

  const openPorts = current?.ports.filter((port) => port.status === 'OPEN') ?? [];
  const addresses = current ? [...current.dns.A, ...current.dns.AAAA] : [];
  const completed = Boolean(current && current.status !== 'running');
  const targetValid = validNetworkTarget(target);
  const operationActive = busy || current?.status === 'running';
  const customPortsValid = (() => {
    try { selectedPorts(); return true; } catch { return false; }
  })();

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">NETWORK &amp; SECURITY OVERVIEW</div>
          <h1>Network Inspector</h1>
          <p>Check DNS, common TCP services, HTTP behavior and TLS basics for a system you are allowed to assess.</p>
        </div>
        <button className="secondary" onClick={onOpenHistory}><ArrowRight size={16} /> Reports &amp; history</button>
      </div>
      {error && <div role="alert" className="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      <form className="panel form inspector-form" onSubmit={(event) => void startInspection(event)}>
        <div className="panel-head">
          <div><h2>Inspect an authorized target</h2><p className="hint">One host at a time · bounded TCP checks · no credentials or request bodies</p></div>
          <span className="safe-label"><ShieldAlert size={15} /> Safe overview</span>
        </div>
        <label>
          Domain, IP address, or URL
          <input aria-label="Network inspection target" autoComplete="url" value={target} disabled={operationActive} onChange={(event) => {
            const nextTarget = event.target.value;
            setTarget(nextTarget);
            if (nextTarget !== target) {
              setAuthorized(false);
              setError('');
              setCurrent(undefined);
              onReportChange(undefined);
            }
          }} placeholder="example.com · 192.168.1.20 · https://example.com/health" required maxLength={500} />
          <span className="hint">Query strings and fragments are removed before a check and are never saved.</span>
        </label>
        <div className="columns">
          <SelectField label="TCP port preset" value={preset} options={PORT_PRESET_OPTIONS} onChange={setPreset} disabled={operationActive} />
          <SelectField label="Connection timeout" value={String(timeout)} options={TIMEOUT_OPTIONS} onChange={(value) => setTimeout(Number(value))} disabled={operationActive} />
        </div>
        {preset === 'custom' && <label>Custom TCP ports (comma separated)<input aria-label="Custom TCP ports" inputMode="numeric" value={customPorts} disabled={operationActive} onChange={(event) => setCustomPorts(event.target.value)} placeholder="80, 443, 8080" /><span className="hint">Enter up to 20 unique ports from 1 to 65535.</span></label>}
        <label className="checkbox authorization-check">
          <input type="checkbox" checked={authorized} disabled={operationActive} aria-describedby="network-authorization-help" onChange={(event) => setAuthorized(event.target.checked)} />
          I own this server or have permission to test it.
        </label>
        <p id="network-authorization-help" className="permission-hint" role="note">
          <ShieldCheck size={15} aria-hidden="true" />
          Confirm that you own or have permission to test this target before starting.
        </p>
        <p className="consent-note">Each selected port receives a short TCP connection attempt. HTTP checks send HEAD requests only. This tool does not exploit services, authenticate, or scan ranges.</p>
        <div className="buttons inspector-actions">
          <button className="primary" disabled={operationActive || !targetValid || !authorized || !customPortsValid} aria-describedby="network-authorization-help" aria-busy={operationActive}>
            {busy || current?.status === 'running' ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {busy ? 'Starting scan…' : current?.status === 'running' ? 'Scan running…' : 'Start Scan'}
          </button>
          {completed && <button type="button" className="secondary" onClick={() => { setCurrent(undefined); onReportChange(undefined); }}>New check</button>}
        </div>
      </form>

      {current && <section className="inspector-report" aria-live="polite">
        {current.status === 'running' && <div className="panel scan-progress"><span className="spinner" /><div><strong>Checking {current.hostname}</strong><p role="status" aria-live="polite">{current.progress}</p></div><button type="button" className="secondary" onClick={() => void cancelInspection()} disabled={cancelling} aria-busy={cancelling}>{cancelling ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Square size={15} aria-hidden="true" />}{cancelling ? 'Stopping…' : 'Cancel scan'}</button></div>}
        {current.error && current.status !== 'running' && <div className={current.status === 'error' ? 'alert' : 'notice'}>{current.error}</div>}
        {completed && <>
          <div className="heading compact-heading">
              <div><div className="eyebrow">INSPECTION REPORT</div><h2>{current.target}</h2><p>{formatRunTimestamp(current.started)} · {current.status === 'complete' ? 'Completed' : current.status}</p></div>
            <div className="buttons">
              <a className="secondary" href={`/api/network/reports/${current.id}/json`}><Download size={15} /> JSON</a>
              <a className="secondary" href={`/api/network/reports/${current.id}/html`}><Download size={15} /> HTML</a>
            </div>
          </div>
          <div className="inspector-stats">
            <article><span>Resolved addresses</span><strong>{addresses.length || '—'}</strong><small>{addresses.slice(0, 2).join(', ') || current.dns.note || 'No IP addresses reported'}</small></article>
            <article><span>TCP ports open</span><strong>{openPorts.length}</strong><small>{openPorts.map((port) => port.port).join(', ') || 'None of the selected ports accepted a connection'}</small></article>
            <article><span>HTTP / HTTPS</span><strong>{current.http.map((check) => check.status ? `${check.scheme.toUpperCase()} ${check.status}` : `${check.scheme.toUpperCase()} —`).join(' · ') || 'Not available'}</strong><small>HEAD response only</small></article>
            <article><span>TLS expiry</span><strong>{current.tls?.daysUntilExpiry !== undefined ? `${current.tls.daysUntilExpiry} days` : current.tls?.error || 'Not checked'}</strong><small>{current.tls?.protocol || 'Certificate summary only'}</small></article>
          </div>
          <section className="panel findings-panel"><div className="panel-head"><h2>Findings &amp; recommendations</h2><span>{current.findings.length} observations</span></div><div className="finding-list">{current.findings.map((finding, index) => <article className="finding" key={`${finding.title}-${index}`}><span className={`severity severity-${finding.severity.toLowerCase()}`}>{finding.severity}</span><div><strong>{finding.title}</strong><p>{finding.detail}</p></div></article>)}</div></section>
          <section className="panel form report-section"><h2>DNS summary</h2><p className="hint">System resolver · {current.dns.lookupTimeMs} ms</p><div className="record-grid">
            <div><span>A records</span><strong>{current.dns.A.join(', ') || '—'}</strong></div><div><span>AAAA records</span><strong>{current.dns.AAAA.join(', ') || '—'}</strong></div><div><span>CNAME</span><strong>{current.dns.CNAME.join(', ') || '—'}</strong></div><div><span>Name servers</span><strong>{current.dns.NS.join(', ') || '—'}</strong></div><div><span>Mail servers</span><strong>{current.dns.MX.map((record) => `${record.exchange} (${record.priority})`).join(', ') || '—'}</strong></div><div><span>Reverse lookup</span><strong>{current.dns.reverse.map((record) => `${record.address}: ${record.names.join(', ')}`).join('; ') || '—'}</strong></div>
          </div>{current.dns.note && <p className="hint">{current.dns.note}</p>}</section>
          <section className="panel form report-section"><h2>Approximate IP location</h2>
            <p className="hint">Uses only the local database files selected in Settings. IPs are not sent to a geolocation service. Results can differ for CDNs, anycast, proxies, VPNs, and shared networks.</p>
            {current.geolocation?.length ? <div className="tablewrap"><table><thead><tr><th>IP address</th><th>Estimated location</th><th>ASN and organization</th><th>Database</th></tr></thead><tbody>{current.geolocation.map((item) => <tr key={item.ip}><td className="mono">{item.ip}</td><td>{item.status === 'private' ? 'Private or reserved address' : item.status === 'unavailable' ? 'Local database unavailable' : item.status === 'not-found' ? 'Unknown' : [item.city, item.region, item.country, item.countryCode].filter(Boolean).join(', ') || 'Unknown'}{item.status === 'found' && item.accuracyRadiusKm !== undefined && <small className="geo-subline">Accuracy radius about {item.accuracyRadiusKm} km</small>}{item.timeZone && <small className="geo-subline">Estimated time zone: {item.timeZone}</small>}</td><td>{item.asn ? `AS${item.asn}` : '—'}{item.organization && <small className="geo-subline">{item.organization}</small>}</td><td>{item.source || '—'}{item.cityDatabaseDate && <small className="geo-subline">City: {new Date(item.cityDatabaseDate).toLocaleDateString()}</small>}{item.asnDatabaseDate && <small className="geo-subline">ASN: {new Date(item.asnDatabaseDate).toLocaleDateString()}</small>}</td></tr>)}</tbody></table></div> : <p className="empty-line">No local geolocation database is configured. Choose optional City and ASN .mmdb files in Settings to see available estimates.</p>}
            <p className="hint">IP location is approximate and cannot prove a server's physical location. It must not be used to identify a household. Time zone is an estimate from the database, not a confirmed server time zone.</p>
          </section>
          <section className="panel form report-section"><h2>TCP port results</h2><p className="hint">Connection acceptance shows reachability only; a port is not automatically a vulnerability.</p><div className="tablewrap"><table><thead><tr><th>Port</th><th>Protocol</th><th>Status</th><th>Time</th><th>Note</th></tr></thead><tbody>{current.ports.map((port) => <tr key={port.port}><td>{port.port}</td><td>{port.protocol}</td><td><span className={`badge port-${port.status.toLowerCase()}`}>{port.status}</span></td><td>{port.durationMs ?? '—'} ms</td><td>{port.note}</td></tr>)}</tbody></table></div></section>
          <section className="panel form report-section"><h2>HTTP / HTTPS</h2><div className="http-results">{current.http.length ? current.http.map(renderHttpCheck) : <p>No HTTP response recorded.</p>}</div></section>
          <section className="panel form report-section"><h2>TLS certificate</h2>{current.tls ? <div className="record-grid"><div><span>Subject</span><strong>{current.tls.subject || '—'}</strong></div><div><span>Issuer</span><strong>{current.tls.issuer || '—'}</strong></div><div><span>Validity</span><strong>{current.tls.validFrom || '—'} — {current.tls.validTo || '—'}</strong></div><div><span>Protocol</span><strong>{current.tls.protocol || '—'}</strong></div><div><span>Names (SAN)</span><strong>{current.tls.subjectAltNames.join(', ') || '—'}</strong></div><div><span>Fingerprint SHA-256</span><strong>{current.tls.fingerprint256 || '—'}</strong></div><div><span>Certificate status</span><strong>{current.tls.hostnameMismatch ? 'Hostname mismatch' : current.tls.selfSigned ? 'Self-signed' : current.tls.authorized ? 'Trusted by system' : current.tls.error || 'Could not verify trust'}</strong></div></div> : <p className="hint">TLS was not checked because no HTTPS port was selected or identified.</p>}{current.tls?.error && <p className="hint">{current.tls.error}</p>}</section>
          <details className="panel form report-section"><summary>Scope and limitations</summary><ul className="limitations-list">{current.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details>
        </>}
      </section>}
      {!current && <div className="inspector-empty"><span className="empty-icon"><Globe2 size={27} /></span><div><strong>Start with one host</strong><p>Use a domain, an IP address, or an HTTP(S) URL. Network checks run only after you confirm authorization.</p></div><LockKeyhole size={20} aria-hidden="true" /></div>}
    </>
  );
}
