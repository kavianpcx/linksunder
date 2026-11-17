import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { networkInspectionSchema } from '../shared/network';
import {
  buildNetworkFindings,
  classifyPortError,
  inspectNetworkTarget,
  normalizeNetworkTarget,
  summarizeTlsCertificate,
} from '../server/network-inspector';

describe('Network Inspector target and request validation', () => {
  it('accepts domains, IPs and HTTP(S) URLs while removing query secrets', () => {
    expect(normalizeNetworkTarget('example.com').hostname).toBe('example.com');
    expect(normalizeNetworkTarget('2001:db8::1').hostname).toBe('2001:db8::1');
    const url = normalizeNetworkTarget('https://example.com/health?token=secret#section');
    expect(url.target).toBe('https://example.com/health');
    expect(url.port).toBeUndefined();
    const httpPort = normalizeNetworkTarget('example.com:8080/health');
    expect(httpPort.scheme).toBe('http');
    expect(httpPort.target).toBe('http://example.com:8080/health');
    expect(httpPort.port).toBe(8080);
    const securePort = normalizeNetworkTarget('example.com:443/health');
    expect(securePort.scheme).toBe('https');
    expect(securePort.target).toBe('https://example.com/health');
    expect(securePort.port).toBe(443);
  });

  it.each(['file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com', 'not a host']) (
    'rejects unsafe or malformed target %s',
    (target) => expect(() => normalizeNetworkTarget(target)).toThrow(),
  );

  it('requires explicit authorization and a small unique TCP port list', () => {
    expect(networkInspectionSchema.safeParse({ target: 'example.com', ports: [80] }).success).toBe(false);
    expect(networkInspectionSchema.safeParse({ target: 'example.com', ports: [80, 80], authorized: true }).success).toBe(false);
    expect(networkInspectionSchema.safeParse({ target: 'example.com', ports: Array.from({ length: 21 }, (_, i) => i + 1), authorized: true }).success).toBe(false);
    expect(networkInspectionSchema.safeParse({ target: 'example.com', ports: [80], authorized: true }).success).toBe(true);
  });
});

describe('Network Inspector summaries', () => {
  it('classifies refused connections as closed and timeouts as unknown', () => {
    expect(classifyPortError('ECONNREFUSED')).toBe('CLOSED');
    expect(classifyPortError('ETIMEDOUT')).toBe('UNKNOWN');
    expect(classifyPortError('EHOSTUNREACH')).toBe('UNKNOWN');
    expect(classifyPortError('EACCES')).toBe('ERROR');
  });

  it('summarizes TLS expiry, names and hostname mismatch honestly', () => {
    const expiry = new Date(Date.now() + 12 * 86_400_000).toUTCString();
    const result = summarizeTlsCertificate({
      subject: { CN: 'service.example.test' },
      issuer: { CN: 'Test CA' },
      valid_from: new Date().toUTCString(),
      valid_to: expiry,
      subjectaltname: 'DNS:service.example.test, DNS:www.example.test',
      fingerprint256: 'AA:BB',
      protocol: 'TLSv1.3',
      authorized: false,
      authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID',
    }, 443);
    expect(result.daysUntilExpiry).toBeGreaterThanOrEqual(11);
    expect(result.daysUntilExpiry).toBeLessThanOrEqual(12);
    expect(result.hostnameMismatch).toBe(true);
    expect(result.subjectAltNames).toEqual(['service.example.test', 'www.example.test']);
    expect(result.protocol).toBe('TLSv1.3');
  });

  it('creates actionable HTTP and exposed-service findings without overclaiming', () => {
    const findings = buildNetworkFindings(
      [{ port: 5432, protocol: 'TCP', status: 'OPEN' }],
      [
        { scheme: 'http', status: 200, redirectChain: [], redirectsToHttps: false, securityHeaders: {}, cookieFlags: [] },
        { scheme: 'https', status: 200, redirectChain: [], securityHeaders: { 'strict-transport-security': { present: false }, 'content-security-policy': { present: false } }, cookieFlags: [] },
      ],
    );
    expect(findings.map((finding) => finding.title)).toContain('HTTP does not redirect to HTTPS');
    expect(findings.map((finding) => finding.title)).toContain('Review access to TCP port 5432');
    expect(findings.find((finding) => finding.title.includes('5432'))?.detail).toContain('not automatically a vulnerability');
  });

  it('performs a local HEAD check and stores only cookie flags, not cookie values', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain');
      response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
      response.setHeader('set-cookie', 'session=private-value; Secure; HttpOnly; SameSite=Lax');
      response.end();
    });
    const base = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    try {
      const port = Number(new URL(base).port);
      const request = networkInspectionSchema.parse({ target: `127.0.0.1:${port}/health?key=private`, ports: [port], timeout: 700, authorized: true });
      const report = await inspectNetworkTarget(request, '00000000-0000-4000-8000-000000000001', new AbortController().signal);
      expect(report.status).toBe('complete');
      expect(report.target).toBe(`http://127.0.0.1:${port}/health`);
      expect(report.ports[0].status).toBe('OPEN');
      expect(report.http[0].status).toBe(200);
      expect(report.http).toHaveLength(1);
      expect(report.tls).toBeUndefined();
      expect(report.http[0].securityHeaders['strict-transport-security']).toEqual({ present: true, summary: 'max-age=31536000; includeSubDomains' });
      expect(report.http[0].cookieFlags).toEqual([{ secure: true, httpOnly: true, sameSite: 'lax' }]);
      expect(JSON.stringify(report)).not.toContain('private-value');
      expect(JSON.stringify(report)).not.toContain('private');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('returns a saved cancelled summary when cancellation was requested', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = networkInspectionSchema.parse({ target: '127.0.0.1', ports: [80], timeout: 500, authorized: true });
    const started = Date.now();
    const report = await inspectNetworkTarget(request, '00000000-0000-4000-8000-000000000002', controller.signal);
    expect(Date.now() - started).toBeLessThan(250);
    expect(report.status).toBe('cancelled');
    expect(report.progress).toBe('Cancelled');
  });
});
