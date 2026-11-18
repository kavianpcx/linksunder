import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, LoaderCircle, Play, ShieldCheck, Square } from 'lucide-react';
import { apiMethods, apiTestSchema, type ApiTestRun } from '../shared/api-test';
import { api } from './api';
import { SelectField } from './SelectField';
import { NumberField } from './NumberField';

const methodOptions = apiMethods.map((method) => ({ value: method, label: method }));
const faultOptions = [
  { value: 'none', label: 'Normal request' },
  { value: 'http-503', label: 'Simulate HTTP 503 at LinkSunder' },
  { value: 'latency', label: 'Add response delay' },
  { value: 'interrupt', label: 'Interrupt the connection' },
  { value: 'timeout', label: 'Apply a short timeout' },
];
const redirectOptions = [
  { value: 'manual', label: 'Stop at redirects' },
  { value: 'same-origin', label: 'Follow same-origin redirects' },
];
const retryOptions = [0, 1, 2].map((value) => ({ value: String(value), label: value === 0 ? 'No retries' : `${value} ${value === 1 ? 'retry' : 'retries'}` }));

function parseLines(value: string, separator: ':' | '=') {
  return value.split('\n').map((line) => {
    const position = line.indexOf(separator);
    return position < 1 ? undefined : { name: line.slice(0, position).trim(), value: line.slice(position + 1).trim() };
  }).filter((item): item is { name: string; value: string } => Boolean(item?.name));
}

function parseAssertions(value: string) {
  return value.split('\n').map((line) => {
    const [path, operator, ...rest] = line.split('|').map((part) => part.trim());
    return path && (operator === 'exists' || operator === 'equals')
      ? { path, operator, expected: rest.join('|') }
      : undefined;
  }).filter((item): item is { path: string; operator: 'exists' | 'equals'; expected: string } => Boolean(item));
}

const statusLabel = (status: string) => ({
  running: 'RUNNING', pass: 'PASS', fail: 'FAIL', error: 'ERROR', cancelled: 'CANCELLED',
  observed: 'OBSERVED', 'not-tested': 'NOT TESTED', 'fault-not-triggered': 'FAULT NOT TRIGGERED',
}[status] || status);

export function ApiTestBuilder() {
  const [name, setName] = useState('My API check');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<(typeof apiMethods)[number]>('GET');
  const [queryText, setQueryText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [body, setBody] = useState('');
  const [timeout, setTimeout] = useState(10000);
  const [redirectPolicy, setRedirectPolicy] = useState('manual');
  const [expectedStatus, setExpectedStatus] = useState(200);
  const [expectedTimeMs, setExpectedTimeMs] = useState(0);
  const [expectedHeadersText, setExpectedHeadersText] = useState('');
  const [jsonAssertionsText, setJsonAssertionsText] = useState('');
  const [jsonSchemaText, setJsonSchemaText] = useState('');
  const [retries, setRetries] = useState(0);
  const [fault, setFault] = useState('none');
  const [faultDelayMs, setFaultDelayMs] = useState(1000);
  const [confirmUnsafe, setConfirmUnsafe] = useState(false);
  const [externalConsent, setExternalConsent] = useState(false);
  const [run, setRun] = useState<ApiTestRun>();
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let live = true;
    const poll = async () => {
      try {
        const current = await api<ApiTestRun>(`/api/runs/${run.id}`);
        if (!live) return;
        setRun(current);
        if (current.status !== 'running') {
          setBusy(false);
          busyRef.current = false;
          setCancelling(false);
          cancelRef.current = false;
        }
      } catch (reason) {
        if (live) setError((reason as Error).message);
      }
    };
    const timer = window.setInterval(() => void poll(), 500);
    void poll();
    return () => { live = false; window.clearInterval(timer); };
  }, [run?.id, run?.status]);

  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const targetValid = (() => { try { return ['http:', 'https:'].includes(new URL(url).protocol) && Boolean(new URL(url).hostname); } catch { return false; } })();
  const active = busy || run?.status === 'running';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !externalConsent) return;
    setError('');
    const raw = {
      name, url, method, externalConsent, query: parseLines(queryText, '='), headers: parseLines(headerText, ':'), body,
      timeout, redirectPolicy, expectedStatus, expectedTimeMs: expectedTimeMs || undefined,
      expectedHeaders: expectedHeadersText.split('\n').map((line) => line.trim()).filter(Boolean),
      jsonAssertions: parseAssertions(jsonAssertionsText), jsonSchema: jsonSchemaText,
      retries, fault, faultDelayMs, confirmUnsafe,
    };
    const parsed = apiTestSchema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const started = await api<ApiTestRun>('/api/api-tests', parsed.data);
      setRun(started);
    } catch (reason) {
      busyRef.current = false;
      setBusy(false);
      setError((reason as Error).message);
    }
  }

  async function cancel() {
    if (cancelRef.current) return;
    cancelRef.current = true;
    setCancelling(true);
    try { await api('/api/api-tests/cancel', {}); }
    catch (reason) { cancelRef.current = false; setCancelling(false); setError((reason as Error).message); }
  }

  return <>
    <div className="heading"><div><div className="eyebrow">CONTROLLED API CHECKS</div><h1>API Test Builder</h1><p>Send a bounded request, check its response, and compare normal behavior with a controlled client-side fault.</p></div></div>
    {error && <div className="alert" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    <form className="panel form api-test-form" onSubmit={(event) => void submit(event)}>
      <h2>Request</h2>
      <div className="columns"><label>Test name<input required maxLength={100} value={name} disabled={active} onChange={(event) => setName(event.target.value)} /></label><SelectField label="Method" value={method} options={methodOptions} disabled={active} onChange={(value) => { const next = value as (typeof apiMethods)[number]; setMethod(next); if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(next)) { setRetries(0); setFault('none'); } else if (!['POST', 'PUT', 'PATCH'].includes(next)) setBody(''); setConfirmUnsafe(false); }} /></div>
      <label>Endpoint<input type="url" required maxLength={2000} value={url} disabled={active} onChange={(event) => { setUrl(event.target.value); setExternalConsent(false); }} placeholder="https://api.example.com/health" /></label>
      <label>Query parameters (one name=value per line)<textarea value={queryText} disabled={active} onChange={(event) => setQueryText(event.target.value)} placeholder={'limit=10\nstatus=active'} /></label>
      <details><summary>Headers and body</summary>
        <label>Request headers (one name: value per line)<textarea value={headerText} disabled={active} onChange={(event) => setHeaderText(event.target.value)} placeholder={'Accept: application/json\nAuthorization: Bearer …'} /><span className="hint">Header values are sent for this request and are never saved in reports.</span></label>
        {['POST', 'PUT', 'PATCH'].includes(method) && <label>Request body<textarea value={body} disabled={active} onChange={(event) => setBody(event.target.value)} placeholder={'{"name":"example"}'} /><span className="hint">The body is sent once and is never saved to the report.</span></label>}
      </details>
      {unsafe && <label className="checkbox"><input type="checkbox" checked={confirmUnsafe} disabled={active} onChange={(event) => setConfirmUnsafe(event.target.checked)} />I understand {method} may change or delete server data. Send exactly one request, with no automatic retries or fault replay.</label>}
      <div className="columns"><NumberField label="Timeout (ms)" value={timeout} min={500} max={30000} disabled={active} onChange={setTimeout} /><SelectField label="Redirect behavior" value={redirectPolicy} options={redirectOptions} disabled={active} onChange={setRedirectPolicy} /></div>
      <section className="api-assertions"><h2>Expected response</h2><div className="columns"><NumberField label="Expected HTTP status" value={expectedStatus} min={100} max={599} disabled={active} onChange={setExpectedStatus} /><NumberField label="Maximum response time (ms) · optional" value={expectedTimeMs} min={0} max={30000} disabled={active} onChange={setExpectedTimeMs} /></div>
        <label>Required response headers (one name per line)<textarea value={expectedHeadersText} disabled={active} onChange={(event) => setExpectedHeadersText(event.target.value)} placeholder={'content-type\nx-request-id'} /></label>
        <label>JSON checks (path | exists or equals | expected value)<textarea value={jsonAssertionsText} disabled={active} onChange={(event) => setJsonAssertionsText(event.target.value)} placeholder={'data.id | exists\ndata.status | equals | "ready"'} /></label>
        <details><summary>JSON Schema (optional)</summary><label>Schema<textarea value={jsonSchemaText} disabled={active} onChange={(event) => setJsonSchemaText(event.target.value)} placeholder={'{"type":"object","required":["data"],"properties":{"data":{"type":"object"}}}'} /></label><p className="hint">Supported checks: type, required, properties, enum, items, minLength, maxLength, minimum and maximum.</p></details>
      </section>
      <details><summary>Fault, recovery and retry</summary>
        <div className="columns"><SelectField label="Fault simulation" value={fault} options={faultOptions} disabled={active || unsafe} onChange={setFault} /><SelectField label="Safe-method retry count" value={String(retries)} options={retryOptions} disabled={active || unsafe} onChange={(value) => setRetries(Number(value))} /></div>
        {fault === 'latency' && <NumberField label="Added delay (ms)" value={faultDelayMs} min={1} max={15000} disabled={active} onChange={setFaultDelayMs} />}
        {unsafe && <p className="hint">Faults and retries are disabled for data-changing methods. LinkSunder never replays them automatically.</p>}
        <p className="hint">Faults are applied at LinkSunder's local client boundary. They do not change the API server. Safe methods are requested once for baseline, once under the fault, and once for recovery.</p>
      </details>
      <label className="checkbox authorization-check"><input type="checkbox" checked={externalConsent} disabled={active} onChange={(event) => setExternalConsent(event.target.checked)} /><ShieldCheck size={15} aria-hidden="true" />I own this API or have permission to test it.</label>
      <p className="permission-hint">Confirm that you own or have permission to test this target before starting.</p>
      <div className="buttons"><button className="primary" disabled={active || !targetValid || !externalConsent || (unsafe && !confirmUnsafe)} aria-busy={active}>{active ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{active ? 'Request running…' : 'Run API Test'}</button>{active && <button type="button" className="secondary" disabled={cancelling} aria-busy={cancelling} onClick={() => void cancel()}>{cancelling ? <LoaderCircle size={16} className="spin" /> : <Square size={15} />}{cancelling ? 'Cancelling…' : 'Cancel'}</button>}</div>
    </form>
    {run && <section className="panel form api-test-result" aria-live="polite">
      <div className="panel-head"><div><div className="eyebrow">API TEST REPORT</div><h2>{run.name}</h2></div><span className={`badge ${run.status}`}>{statusLabel(run.status)}</span></div>
      {run.error && <div className="alert">{run.error}</div>}{run.advice && <p className="hint">{run.advice}</p>}
      <div className="api-phases">{(['baseline', 'disrupted', 'recovery'] as const).map((phase) => {
        const sample = run.apiTest?.[phase];
        if (!sample) return null;
        return <article key={phase}><h3>{phase === 'baseline' ? 'Baseline' : phase === 'disrupted' ? 'During fault' : 'Recovery'}</h3><strong>{sample.statusCode ? `HTTP ${sample.statusCode}` : sample.failureReason || 'No response'}</strong><p>{sample.responseTimeMs ?? '—'} ms · {sample.contentType || 'Unknown content type'}</p>{sample.originalStatusCode && <p>Server returned HTTP {sample.originalStatusCode}; LinkSunder displayed the simulated 503 locally.</p>}{sample.failureReason && <p role="status">{sample.failureReason}</p>}<p>Redirects: {sample.redirectChain.join(' → ') || 'none'} · HTTP version: {sample.httpVersion || 'not available'}</p><ul>{Object.entries(sample.responseHeaders).map(([key, value]) => <li key={key}>{key}: {value}</li>)}</ul>{sample.preview && <details><summary>Redacted response preview (temporary)</summary><pre className="response-preview">{sample.preview}</pre><p className="hint">Response previews are temporary and are never saved in reports.</p></details>}</article>;
      })}</div>
      {run.apiTest?.faultNote && <p className="inline-warning">{run.apiTest.faultNote}</p>}
      <h3>Assertions</h3><ol className="api-assertion-list">{run.steps.map((step, index) => <li key={index}><span className={`badge ${step.status}`}>{step.status === 'pass' ? 'PASS' : 'FAIL'}</span>{step.message}</li>)}</ol>
      {run.apiTest?.limitations.map((item) => <p className="hint" key={item}>{item}</p>)}
      {run.status !== 'running' && <div className="buttons"><a className="secondary" href={`/api/reports/${run.id}/json`}><Download size={15} /> JSON report</a><a className="secondary" href={`/api/reports/${run.id}/html`}><Download size={15} /> HTML report</a></div>}
    </section>}
  </>;
}
