# LinkSunder v0.4.0 security review

Review date: 2026-11-18. This is a focused code and dependency review for the v0.4.0
development branch, not a third-party penetration test or formal security certification.

## Application boundaries reviewed

- Electron creates a sandboxed, context-isolated window with Node integration disabled.
  Navigation to another origin and new windows are denied; permission requests are
  rejected. The preload exposes narrow, typed operations and each privileged IPC
  handler verifies the sender's local origin.
- The local Fastify engine binds to loopback and validates Host/Origin, mutation
  headers, payload shape, and request size. Execution admission is reserved before
  asynchronous work, only one test/inspection/storage migration runs at a time, and
  reports and settings use server-selected paths rather than paths supplied by the UI.
- Scenario and Network Inspector execution requires explicit ownership/permission
  confirmation, validated again by the server. Network inspection is single-host,
  bounds ports and concurrency, uses short timeouts and HEAD requests, does not retain
  response bodies or cookie values, and limits redirects to the same hostname.
- Geolocation is optional and local. City and ASN databases are opened from paths
  selected by the user; no IP address is sent to a location service. Private, reserved,
  documentation, and invalid addresses are excluded. Location is approximate and
  cannot identify a household. No MaxMind database is bundled.
- Updates are user-triggered. Packages are downloaded only after the user chooses to
  download, checked against the SHA-512 values in the GitHub release metadata, and
  installed only after confirmation and an idle-operation check. SHA-512 verifies
  consistency with that metadata; it does not establish publisher identity. Windows
  and Linux packages currently lack commercial code signatures.

## Dependency audit

On the review date, `npm audit --omit=dev` reported **0 vulnerabilities** for the
production dependency tree. The full development dependency tree reported **17 high
severity entries**, all resolving through the unpatched `picomatch` ReDoS advisory
GHSA-fc5q-39xc-vjpf (CVE-2026-112366). The installed `picomatch` is 4.0.7; the
[GitHub advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) listed no patched
version on 2026-11-18. The affected packages are development/build tools (`vite`,
`vitest`, `typescript-eslint`, and `electron-builder` dependency chains); they are not
included in the production audit. The full audit was rerun before release preparation;
repeat it when an upstream fix is available and before the next release.

## Remaining limits

- Unsigned installers may show operating-system publisher warnings. Users must follow
  their organization's policy; disabling system protections is not recommended.
- DNS checks do not pin resolved addresses through the full browser connection and
  cannot eliminate DNS rebinding. The application is intended for a trusted,
  single-user desktop and is not a hostile-site sandbox or a complete network firewall.
- Local report files are not encrypted at rest. Protect the operating-system account
  and any exported reports, screenshots, scenarios, and geolocation database files.
- Automated tests and this review do not replace a manual review of release binaries
  or an independent security assessment.
