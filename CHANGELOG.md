# Changelog

## 0.5.2

- Added a small top margin before the report history table for clearer separation from its filters.
- Added one-click rerun for recent resilience reports, keeping inputs local and outside report exports.
- Re-checks target authorization before a rerun and adapts the disruption step when the test type changes.
- Clears saved rerun inputs when the corresponding report is deleted.

## 0.5.1

- Added system-supported IANA time zones alongside local time and UTC for report timestamps.
- Added resumable ranged downloads, blockmap-based differential package updates when a compatible base is available, and pause, resume, cancel, and close-and-resume controls.
- Added a compact update progress panel with expandable details outside Settings.
- Published updater blockmaps and AppImage blockmap metadata so supported updates can avoid unchanged package blocks.
- Kept Network Inspector checks bounded to one authorized host and clarified the limits of its security findings.

## 0.4.0

- Added indexed, paginated local report history with incremental migration and recoverable bulk deletion.
- Added optional local MaxMind geolocation and local/UTC timestamp preferences for network reports.
- Added manually controlled in-app updates for Windows installers and Linux AppImages.
- Improved authorization gating, action states, themed controls, accessibility, and large-history performance.

## 0.3.0

- Added a single-target Network Inspector for DNS, bounded TCP reachability, safe HTTP header checks, TLS certificate summaries, findings, cancellation, and JSON/HTML exports.
- Added searchable unified history for resilience tests and network inspections, with confirmed individual, bulk, and clear-all deletion.
- Added configurable local report storage with verified copy migration, persistent preferences, and safer Electron folder selection and window controls.
- Refined the desktop interface with accessible custom dropdowns, theme-aware scrollbars, consistent form controls, keyboard focus handling, tooltips, and responsive layouts.
- Expanded English and Persian guides, screenshots, safety boundaries, and Windows/Linux desktop release automation.

## 0.2.0

- Desktop application with an isolated Electron window and automatically managed local engine.
- Windows installer/portable and Linux DEB/AppImage distribution pipeline with bundled Chromium.
- Saved scenarios and graphical report downloads; no end-user terminal setup.
- Stable local origin across desktop restarts, automatic port conflict handling and report storage in user data.
- Desktop smoke checks exercise a real assertion and verify engine shutdown, including packaged applications.
- Windows/Linux scope clarified; no claim of Android/iOS support.

## 0.1.0

- Initial local React dashboard and Fastify/Playwright runner.
- Offline recovery, HTTP 503 injection and selected-request delays.
- Ordered scenario builder, JSON import/export and explicit assertions.
- Real broken/fixed draft-preservation demo and persistent history.
- Opt-in masked screenshots, standalone HTML/JSON reports and cancellation.
- Light/dark responsive UI, browser integration tests and CI configuration.
