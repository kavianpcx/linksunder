# LinkSunder v0.4.0

LinkSunder v0.4.0 improves large local report histories, adds optional offline IP
geolocation, and introduces user-controlled in-app updates for supported desktop
packages. Existing scenarios, reports, and desktop workflows remain available.

## Large report histories

- Added a local SQLite metadata index and backend pagination for 10, 20, or 50 rows.
- Search, date, type, status, and sort filters run against the local index. Full JSON,
  HTML, and screenshot content is not transferred for ordinary history pages.
- Existing report folders are indexed incrementally with visible progress. Original
  report files are preserved, and damaged files remain available for recovery.
- Clear-all deletion runs in recoverable batches with progress and accurate error
  counts. A staged deletion journal protects report files during interruptions.
- Report-directory migration is asynchronous, cancellable, verifies copies, and keeps
  source files until the destination is fully indexed.
- Results for 100, 10,000, and 100,000 local reports are published in the
  [history benchmark](benchmarks/history-v0.4.0.md).

## Network Inspector and geolocation

- HTTP 2xx, 3xx, 4xx, 5xx, transport errors, timeouts, and unknown results have distinct
  descriptions and visual states.
- Optional offline MaxMind City and ASN `.mmdb` databases add approximate location,
  network, and organization information to public IP observations. No address is sent
  to a geolocation service, and no database is bundled.
- Private, reserved, documentation, and invalid IP addresses are excluded. IP-based
  time-zone data is identified as an estimate.
- Users can choose local or UTC timestamp display.

## User-controlled software updates

- Added an Updates section in Settings with manual checks, release notes, package size,
  real download progress, cancel/retry, and explicit restart/install confirmation.
- No background update checks, downloads, or installation are performed.
- In-app updates are supported for installed Windows NSIS and Linux AppImage packages.
  Windows portable ZIP and Linux DEB packages continue to use manual platform updates.
- Pause/resume is not advertised. User reports, settings, and scenarios stay outside
  the installation directory.

## Authorization and interface

- Scenario Builder and Network Inspector require explicit ownership/permission
  confirmation before starting. The server validates authorization independently,
  and changing a target resets consent.
- Disabled, loading, running, cancellation, success, and error action states are more
  consistent and use clear labels with Lucide icons.
- Refined themed controls, scrollbar colors, focus states, tooltips, and responsive
  history pagination.

## Safety and limitations

- Network inspection remains one authorized host at a time with bounded ports and
  concurrency. Findings are observations, not a vulnerability verdict.
- MaxMind data must be obtained and maintained by the user under MaxMind's terms.
- Public installers currently do not have commercial code signatures. SHA-512 release
  metadata detects download changes but does not prove publisher identity.
- See [SECURITY.md](../SECURITY.md) and the
  [focused v0.4.0 review](security-review-v0.4.0.md) for boundaries and dependency
  audit details.

## Downloads

- [Windows x64 installer](https://github.com/kavianpcx/linksunder/releases/download/v0.4.0/LinkSunder-0.4.0-Windows-x64.exe)
- [Windows x64 portable ZIP](https://github.com/kavianpcx/linksunder/releases/download/v0.4.0/LinkSunder-0.4.0-Windows-x64.zip)
- [Ubuntu/Debian x64 installer](https://github.com/kavianpcx/linksunder/releases/download/v0.4.0/LinkSunder-0.4.0-Linux-amd64.deb)
- [Linux x64 AppImage](https://github.com/kavianpcx/linksunder/releases/download/v0.4.0/LinkSunder-0.4.0-Linux-x86_64.AppImage)
- [SHA-256 checksums for packages and updater manifests](https://github.com/kavianpcx/linksunder/releases/download/v0.4.0/SHA256SUMS.txt)

Use the checksum file to verify downloaded bytes. It does not establish publisher
identity because the packages are not code-signed.

## Acknowledgments

Thank you to @Golden007-prog and @joshuaallgaier2-cmd for their contributions to
earlier LinkSunder releases, which remain part of the project.
