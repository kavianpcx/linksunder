import { describe, expect, it } from 'vitest';
import { htmlNetworkReport } from '../server/report';
import type { NetworkReport } from '../shared/network';

describe('network HTML reports', () => {
  it('escapes malformed imported numeric fields before placing them in HTML', () => {
    const report: NetworkReport = {
      id: '00000000-0000-4000-8000-000000000031',
      kind: 'network',
      target: 'https://example.test/',
      hostname: 'example.test',
      started: '2026-11-17T00:00:00.000Z',
      status: 'complete',
      progress: 'Complete',
      dns: { A: [], AAAA: [], CNAME: [], NS: [], MX: [], reverse: [], lookupTimeMs: 2 },
      ports: [{ port: 443, protocol: 'TCP', status: 'OPEN', durationMs: 3 }],
      http: [],
      findings: [],
      limitations: [],
    };
    const malformed = {
      ...report,
      ports: [{
        ...report.ports[0],
        port: '<img src=x onerror=alert(1)>',
      } as unknown as NetworkReport['ports'][number]],
    };

    const html = htmlNetworkReport(malformed);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
