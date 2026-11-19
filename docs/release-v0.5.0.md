# LinkSunder v0.5.0

LinkSunder v0.5.0 improves the accuracy of resilience results, adds a focused API Test Builder, and makes Network Inspector diagnostics more explicit.

## Highlights

- Resilience reports now require evidence of baseline behavior, a real matching disruption request, an assertion during the disruption, and a recovery request and assertion before reporting PASS. Runs without a meaningful flow report NOT TESTED; unmatched faults report FAULT NOT TRIGGERED.
- The bundled draft-preservation example now demonstrates baseline, offline failure, and recovery behavior.
- Network Inspector reports A, AAAA, CNAME, NS, MX, TXT and SOA results with per-record status, timing, bounded retries, and separate operating-system address resolution. NXDOMAIN, no record, timeout, resolver failure, cancellation and unsupported operations are distinguished.
- HTTP checks use HEAD and fall back to a one-byte Range GET when HEAD is rejected. Redirects remain restricted to the original hostname.
- The API Test Builder supports bounded requests, response assertions, JSON checks, a limited JSON Schema subset, explicit safe-method retries, and client-side fault simulation. Data-changing methods require confirmation and are never automatically replayed. Request credentials, request bodies and raw response bodies are not persisted.
- Update cancellation remains available. The current electron-updater integration does not support safe pause/resume: cancelling or interrupting a download discards its partial file, and retry starts from the beginning. Installation remains manual and requires confirmation.

## Verification limits

- HTTP 503 and added latency in the API Test Builder are simulated at LinkSunder's local client boundary; they do not modify the API server.
- The API client does not expose negotiated HTTP version. The builder therefore marks it unavailable.
- JSON Schema validation supports only the documented subset; it is not a complete JSON Schema implementation.
- In-app updates are supported for Windows NSIS and Linux AppImage. Windows portable ZIP and Linux DEB updates remain manual.
- Packages are not commercially code-signed. SHA-512 metadata is verified by the updater, but checksums do not establish publisher identity.
- The desktop package workflow upgrades isolated v0.4.0 Windows NSIS and Linux AppImage installations from a local test feed before release. It verifies real progress, cancellation, a fresh retry from byte zero, package verification, installation, report persistence, and appearance preference persistence. No pause/resume behavior is advertised; an interrupted download must restart.

