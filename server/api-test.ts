import { randomUUID } from 'node:crypto';
import type { Run, StepResult } from '../shared/schema.js';
import type { ApiTestConfig, ApiTestSample } from '../shared/api-test.js';
import { validateTarget } from './security.js';

const BODY_LIMIT = 1024 * 1024;
const PREVIEW_LIMIT = 2000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED_HEADERS = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

interface InternalSample extends ApiTestSample {
  json?: unknown;
  jsonAvailable: boolean;
  originalStatusCode?: number;
}

function publicSample(sample: InternalSample): ApiTestSample {
  const safe: Record<string, unknown> = { ...sample };
  delete safe.json;
  delete safe.jsonAvailable;
  return safe as unknown as ApiTestSample;
}

function headerNameValid(value: string) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function sanitizeUrl(url: URL) {
  const safe = new URL(url);
  safe.search = '';
  safe.hash = '';
  return safe.toString();
}

function safeHeaders(headers: Headers) {
  const output: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (/authorization|cookie|token|secret|password|api[-_]?key/i.test(name)) return;
    if (name === 'location') {
      try { output[name] = sanitizeUrl(new URL(value, 'http://linksunder.invalid')); } catch { output[name] = '[redacted]'; }
    } else if (Object.keys(output).length < 30) {
      output[name] = value.slice(0, 500);
    }
  });
  return output;
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(redactJson);
  if (typeof value === 'string')
    return value
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
      .replace(/\b(?:access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key)\s*[:=]\s*["']?[^\s,"'}]+/gi, '[redacted]');
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key,
    /authorization|cookie|token|secret|password|api[-_]?key|email/i.test(key) ? '[redacted]' : redactJson(item),
  ]));
}

function makePreview(text: string, contentType: string) {
  if (!text) return '(empty response body)';
  if (contentType.toLowerCase().includes('json')) {
    try { return JSON.stringify(redactJson(JSON.parse(text)), null, 2).slice(0, PREVIEW_LIMIT); } catch { /* Use the plain-text redactor below. */ }
  }
  return '[Non-JSON response preview hidden for privacy.]';
}

async function readBody(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= BODY_LIMIT) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > BODY_LIMIT) {
        await reader.cancel();
        throw new Error('Response body exceeded the 1 MB inspection limit.');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function waitForDelay(ms: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    if (signal.aborted) finish(false);
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getJsonPath(value: unknown, path: string) {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return { exists: false, value: undefined };
    const key = /^\d+$/.test(part) ? Number(part) : part;
    if (!(key in current)) return { exists: false, value: undefined };
    current = (current as Record<string | number, unknown>)[key];
  }
  return { exists: true, value: current };
}

function validateJsonSchema(value: unknown, schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${path}: schema must be an object.`];
  const rule = schema as Record<string, unknown>;
  const errors: string[] = [];
  const type = rule.type;
  const matchesType = (candidate: unknown, expected: unknown) => {
    if (expected === 'null') return candidate === null;
    if (expected === 'array') return Array.isArray(candidate);
    if (expected === 'object') return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
    if (expected === 'integer') return Number.isInteger(candidate);
    if (expected === 'number') return typeof candidate === 'number' && Number.isFinite(candidate);
    if (expected === 'string' || expected === 'boolean') return typeof candidate === expected;
    return true;
  };
  if (typeof type === 'string' && !matchesType(value, type)) errors.push(`${path}: expected ${type}.`);
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path}: value is not in the allowed list.`);
  if (Array.isArray(rule.required) && value && typeof value === 'object') {
    for (const key of rule.required) if (typeof key === 'string' && !(key in value)) errors.push(`${path}.${key}: required property is missing.`);
  }
  if (rule.properties && typeof rule.properties === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, childSchema] of Object.entries(rule.properties)) {
      if (key in value) errors.push(...validateJsonSchema((value as Record<string, unknown>)[key], childSchema, `${path}.${key}`));
    }
  }
  if (rule.items && Array.isArray(value)) value.forEach((item, index) => errors.push(...validateJsonSchema(item, rule.items, `${path}[${index}]`)));
  if (typeof value === 'string' && typeof rule.minLength === 'number' && value.length < rule.minLength) errors.push(`${path}: string is shorter than minLength.`);
  if (typeof value === 'string' && typeof rule.maxLength === 'number' && value.length > rule.maxLength) errors.push(`${path}: string is longer than maxLength.`);
  if (typeof value === 'number' && typeof rule.minimum === 'number' && value < rule.minimum) errors.push(`${path}: number is below minimum.`);
  if (typeof value === 'number' && typeof rule.maximum === 'number' && value > rule.maximum) errors.push(`${path}: number is above maximum.`);
  return errors;
}

function addAssertion(run: Run, name: string, pass: boolean, detail: string) {
  const item: StepResult = { action: 'assertion', status: pass ? 'pass' : 'fail', message: detail, duration: 0 };
  run.steps.push(item);
  run.assertions += 1;
  if (pass) run.passed += 1;
  return name;
}

async function requestOnce(
  config: ApiTestConfig,
  initialUrl: URL,
  signal: AbortSignal,
  timeoutMs: number,
  abortAfterMs?: number,
  onRequest: () => void = () => undefined,
): Promise<InternalSample> {
  const redirects: string[] = [];
  let current = new URL(initialUrl);
  const started = Date.now();
  const headers = new Headers();
  for (const item of config.headers) {
    if (!headerNameValid(item.name) || BLOCKED_HEADERS.has(item.name.toLowerCase()) || item.name.toLowerCase().startsWith('proxy-'))
      throw new Error(`The request header “${item.name}” is not allowed.`);
    if (/[\r\n]/.test(item.value)) throw new Error('Request header values cannot contain line breaks.');
    headers.append(item.name, item.value);
  }
  if (config.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const localController = new AbortController();
  const combined = AbortSignal.any([signal, localController.signal, AbortSignal.timeout(timeoutMs)]);
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptionInjected = false;
  if (abortAfterMs !== undefined) interruptTimer = setTimeout(() => {
    interruptionInjected = true;
    localController.abort(new Error('Injected connection interruption.'));
  }, abortAfterMs);
  try {
    for (let hop = 0; hop <= 5; hop += 1) {
      await validateTarget(current.toString(), config.externalConsent);
      onRequest();
      const response = await fetch(current, {
        method: config.method,
        headers,
        body: config.body || undefined,
        redirect: 'manual',
        signal: combined,
      });
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        if (config.redirectPolicy !== 'same-origin' || !SAFE_METHODS.has(config.method)) {
          await response.body?.cancel();
          const text = await readBody(response).catch(() => '');
          return {
            statusCode: response.status,
            responseTimeMs: Date.now() - started,
            contentType: response.headers.get('content-type') || undefined,
            responseHeaders: safeHeaders(response.headers),
            redirectChain: redirects,
            failureReason: 'Redirect was not followed. Choose same-origin redirects to follow safe requests.',
            preview: makePreview(text, response.headers.get('content-type') || ''),
            jsonAvailable: false,
          };
        }
        const next = new URL(location, current);
        if (next.origin !== current.origin || next.username || next.password) {
          await response.body?.cancel();
          return {
            statusCode: response.status,
            responseTimeMs: Date.now() - started,
            contentType: response.headers.get('content-type') || undefined,
            responseHeaders: safeHeaders(response.headers),
            redirectChain: redirects,
            failureReason: 'Stopped at a redirect to a different origin.',
            jsonAvailable: false,
          };
        }
        redirects.push(`${response.status} ${sanitizeUrl(next)}`);
        await response.body?.cancel();
        current = next;
        if (hop === 5) {
          return { statusCode: response.status, responseTimeMs: Date.now() - started, responseHeaders: safeHeaders(response.headers), redirectChain: redirects, failureReason: 'Stopped after five redirects.', jsonAvailable: false };
        }
        continue;
      }
      const text = await readBody(response);
      const contentType = response.headers.get('content-type') || '';
      let json: unknown;
      let jsonAvailable = false;
      if (contentType.toLowerCase().includes('json') && text) {
        try { json = JSON.parse(text); jsonAvailable = true; } catch { /* malformed JSON is exposed to the JSON checks */ }
      }
      return {
        statusCode: response.status,
        responseTimeMs: Date.now() - started,
        contentType: contentType.slice(0, 160) || undefined,
        responseHeaders: safeHeaders(response.headers),
        redirectChain: redirects,
        preview: makePreview(text, contentType),
        json,
        jsonAvailable,
      };
    }
    throw new Error('Redirect limit reached.');
  } catch (error) {
    const message = signal.aborted
      ? 'Cancelled by the user.'
      : error instanceof Error && error.name === 'TimeoutError'
        ? `Timed out after ${timeoutMs} ms.`
      : interruptionInjected
          ? 'Connection interruption injected by LinkSunder.'
          : error instanceof Error
            ? error.message.slice(0, 300)
            : 'The API request failed.';
    return { responseTimeMs: Date.now() - started, responseHeaders: {}, redirectChain: redirects, failureReason: message, jsonAvailable: false };
  } finally {
    if (interruptTimer) clearTimeout(interruptTimer);
  }
}

function evaluateAssertions(config: ApiTestConfig, sample: InternalSample, run: Run, label: string) {
  if (config.expectedStatus !== undefined)
    addAssertion(run, `${label}: expected status`, sample.statusCode === config.expectedStatus, `${label}: expected HTTP ${config.expectedStatus}; received ${sample.statusCode ?? sample.failureReason ?? 'no response'}.`);
  if (config.expectedTimeMs !== undefined)
    addAssertion(run, `${label}: response time`, sample.responseTimeMs !== undefined && sample.responseTimeMs <= config.expectedTimeMs, `${label}: response time ${sample.responseTimeMs ?? 'unavailable'} ms; limit ${config.expectedTimeMs} ms.`);
  for (const name of config.expectedHeaders) {
    const exists = Object.keys(sample.responseHeaders).some((header) => header.toLowerCase() === name.toLowerCase());
    addAssertion(run, `${label}: header ${name}`, exists, `${label}: response header “${name}” ${exists ? 'was present.' : 'was not present.'}`);
  }
  if (config.jsonAssertions.length || config.jsonSchema) {
    for (const assertion of config.jsonAssertions) {
      const result = getJsonPath(sample.json, assertion.path);
      const expected: unknown = (() => { try { return JSON.parse(assertion.expected); } catch { return assertion.expected; } })();
      const matches = assertion.operator === 'exists' ? result.exists : result.exists && JSON.stringify(result.value) === JSON.stringify(expected);
      addAssertion(run, `${label}: JSON ${assertion.path}`, sample.jsonAvailable && matches, `${label}: JSON ${assertion.path} ${sample.jsonAvailable ? matches ? 'matched.' : 'did not match.' : 'could not be checked because no valid JSON response was available.'}`);
    }
    if (config.jsonSchema) {
      try {
        const schema = JSON.parse(config.jsonSchema) as unknown;
        const errors = sample.jsonAvailable ? validateJsonSchema(sample.json, schema).slice(0, 10) : ['Response was not valid JSON.'];
        addAssertion(run, `${label}: JSON Schema`, errors.length === 0, errors.length ? `${label}: JSON response did not match schema: ${errors.join(' ')}` : `${label}: JSON response matched the supported schema checks.`);
      } catch {
        addAssertion(run, `${label}: JSON Schema`, false, `${label}: JSON Schema text is invalid.`);
      }
    }
  }
}

export function createApiTestRun(config: ApiTestConfig): Run {
  const url = new URL(config.url);
  return {
    id: randomUUID(),
    name: config.name,
    targetHost: url.hostname,
    type: 'api',
    status: 'running',
    started: new Date().toISOString(),
    duration: 0,
    steps: [],
    assertions: 0,
    passed: 0,
    screenshots: [],
    network: { failed: 0, injected: 0 },
    apiTest: {
      method: config.method,
      target: sanitizeUrl(url),
      requestCount: 0,
      fault: config.fault,
      faultTriggered: false,
      limitations: [
        'Request headers and bodies are never written to the report. Sensitive response headers are omitted and response previews are redacted.',
        'The HTTP client does not expose the negotiated HTTP version; it is reported as unavailable.',
        'JSON Schema checks support type, required, properties, enum, items, minLength, maxLength, minimum and maximum.',
        'Fault responses are simulated by LinkSunder at the client boundary; they do not alter the API server.',
      ],
    },
  };
}

export async function executeApiTest(config: ApiTestConfig, run: Run, signal: AbortSignal) {
  const started = Date.now();
  const evidence = run.apiTest!;
  try {
    const target = await validateTarget(config.url, config.externalConsent);
    const url = new URL(target);
    for (const item of config.query) url.searchParams.append(item.name, item.value);
    const redirects = new URL(url);
    if (signal.aborted) throw new Error('Cancelled.');
    const send = (timeoutMs = config.timeout, abortAfterMs?: number) => requestOnce(
      config,
      redirects,
      signal,
      timeoutMs,
      abortAfterMs,
      () => { evidence.requestCount += 1; },
    );
    const attempts = SAFE_METHODS.has(config.method) ? config.retries + 1 : 1;
    let baseline: InternalSample | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      baseline = await send();
      const serverError = baseline.statusCode !== undefined && baseline.statusCode >= 500;
      if ((!baseline.failureReason && !serverError) || attempt === attempts - 1 || signal.aborted) break;
    }
    if (!baseline) throw new Error('The API request did not start.');
    evidence.baseline = publicSample(baseline);
    evaluateAssertions(config, baseline, run, 'Baseline');
    if (signal.aborted) throw new Error('Cancelled.');

    if (config.fault !== 'none') {
      let disrupted: InternalSample;
      if (config.fault === 'interrupt') {
        disrupted = await send(config.timeout, Math.min(50, config.timeout));
        evidence.faultTriggered = Boolean(disrupted.failureReason?.includes('interruption'));
        if (!evidence.faultTriggered) evidence.faultNote = 'FAULT NOT TRIGGERED: the endpoint completed before the connection interruption could be applied.';
      } else if (config.fault === 'timeout') {
        const faultTimeout = Math.min(100, config.timeout);
        disrupted = await send(faultTimeout);
        evidence.faultTriggered = Boolean(disrupted.failureReason?.includes('Timed out'));
        if (!evidence.faultTriggered) evidence.faultNote = 'FAULT NOT TRIGGERED: the endpoint responded before the configured timeout window.';
      } else {
        disrupted = await send();
        if (disrupted.statusCode !== undefined && !signal.aborted) {
          evidence.faultTriggered = true;
          run.network.injected = 1;
        } else if (!signal.aborted) {
          evidence.faultNote = `FAULT NOT TRIGGERED: LinkSunder could not apply the selected fault because the request did not return an HTTP response.${disrupted.failureReason ? ` ${disrupted.failureReason}` : ''}`;
        }
        if (config.fault === 'http-503' && evidence.faultTriggered) {
          const original = disrupted.statusCode;
          disrupted.originalStatusCode = original;
          disrupted.statusCode = 503;
          disrupted.failureReason = `HTTP 503 injected locally after the API server returned ${original ?? 'no status'}.`;
        }
        if (config.fault === 'latency' && evidence.faultTriggered) {
          const delayStarted = Date.now();
          evidence.disrupted = publicSample(disrupted);
          const completed = await waitForDelay(config.faultDelayMs, signal);
          disrupted.responseTimeMs = (disrupted.responseTimeMs || 0) + (Date.now() - delayStarted);
          if (!completed) evidence.faultNote = 'Latency simulation was cancelled before its configured delay completed.';
        }
      }
      evidence.disrupted = publicSample(disrupted);
      if (signal.aborted) throw new Error('Cancelled.');
      if (evidence.faultTriggered && SAFE_METHODS.has(config.method)) {
        const recovery = await send();
        evidence.recovery = publicSample(recovery);
        evaluateAssertions(config, recovery, run, 'Recovery');
      }
      if (disrupted.failureReason && !evidence.faultTriggered)
        addAssertion(run, 'Fault injection', false, evidence.faultNote || disrupted.failureReason);
    }

    run.status = signal.aborted
      ? 'cancelled'
      : config.fault !== 'none' && !evidence.faultTriggered
        ? 'fault-not-triggered'
        : run.steps.some((item) => item.status === 'fail')
          ? 'fail'
          : 'pass';
    if (run.status === 'fault-not-triggered') run.error = evidence.faultNote || 'FAULT NOT TRIGGERED.';
    if (config.fault !== 'none' && evidence.faultTriggered && !evidence.recovery)
      run.advice = 'This method was sent once because automatic replay of data-changing methods is disabled. Recovery could not be verified.';
    else if (run.status === 'pass') run.advice = 'Baseline and recovery checks completed. Request body and credentials were not stored.';
  } catch (error) {
    run.status = signal.aborted ? 'cancelled' : 'error';
    run.error = signal.aborted ? 'API test cancelled.' : (error as Error).message.slice(0, 500);
  } finally {
    run.duration = Date.now() - started;
  }
}
