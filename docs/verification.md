# LinkSunder v0.4.0 verification

Local checks run on Windows 11 Education, build 28000, with Node.js v24.22.3 and the
installed Google Chrome. Test data was synthetic or used a local test server; no
public target or private user report was used.

## Checks passed locally

- `npm ci` completed and installed 466 packages.
- `npm run setup` verified the installed Chrome browser.
- `npm run lint` and `npm run typecheck` passed.
- `npm test`: 64 tests passed across 11 files.
- `npm run test:e2e -- --reporter=line --workers=1`: 16 tests passed. Coverage includes
  server-side authorization rejection, consent gating and reset for both test flows,
  real local test/scan cancellation, duplicate-operation protection, HTTP result
  classification, report migration and deletion, keyboard controls, and responsive
  layouts.
- Automated axe WCAG A/AA checks found no violations on tested overview, settings,
  history, and Network Inspector states. Dark and light themes were checked. This is
  automated coverage, not a formal WCAG certification or a full assistive-technology
  audit.
- `npm run build` passed.
- `npm run test:desktop` passed against the actual Electron application: window
  controls, isolated renderer preferences, a real browser assertion, report creation,
  and local-engine shutdown.
- `npm audit --omit=dev` reported zero production dependency vulnerabilities.
- Screenshots were visually inspected at desktop size and at the 390 px responsive
  layout. The authorization explanation and disabled Run Test / Start Scan states
  are visible in the updated screenshots.
- 100, 10,000, and 100,000 synthetic report histories were benchmarked, including
  real history-page filtering and pagination at 100,000 reports. Results and limits
  are recorded in [the benchmark report](benchmarks/history-v0.4.0.md).

## Security audit status

The full dependency audit reports 17 high-severity entries from the development and
build dependency tree through `picomatch` ReDoS (GHSA-fc5q-39xc-vjpf / CVE-2026-112366).
The advisory currently lists no patched version. The affected packages are excluded
from the production dependency audit; the issue is documented in the
[focused security review](security-review-v0.4.0.md). Do not use
`npm audit fix --force`: npm proposes a breaking Vitest downgrade rather than an
upstream patch.

## Package and cross-platform verification

The local Electron smoke test passed, but the local production package build could
not download Playwright's bundled Chromium: the regional CDN returned HTTP 403
(`Access denied: this service is not available in your location`). The local Chrome
browser was sufficient for source and UI tests, but is not substituted into the
release package. Windows and Linux release packages must therefore be built and
verified by the GitHub Actions matrix before publication. CI results are pending
until that matrix runs on the final merged commit.
