# LinkSunder v0.5.1

LinkSunder v0.5.1 expands timestamp preferences and improves desktop update downloads.

## Highlights

- Report timestamps can use local system time, UTC, or an IANA time zone supported by the operating system.
- Update downloads can be paused, resumed, cancelled, and continued after LinkSunder closes and starts again. Saved progress is checked against the release metadata before it resumes.
- When a compatible base package is available, the updater downloads changed blocks. Otherwise, the package downloads in resumable byte ranges.
- A compact update panel stays in the corner outside Settings and opens detailed progress when requested.
- Release packaging now includes Windows updater blockmaps and the embedded AppImage blockmap size required for differential downloads.
- Network Inspector continues to report bounded DNS, TCP, HTTP and TLS observations for one authorized host at a time. Open ports and missing headers are signals to review, not proof of a vulnerability or a full penetration test.

## Verification limits

- The local source suite covers update planning, changed-range downloads, pause/resume, retry, cancellation, metadata validation, timezone formatting, API tests and Network Inspector logic.
- The local environment cannot launch the Chromium/Electron GUI test processes, so the graphical smoke and end-to-end tests must pass in the Windows and Linux desktop-package workflow before publication.
- Windows portable ZIP and Linux DEB packages still require manual updates. In-app updates are for Windows NSIS and Linux AppImage packages.
- Packages are unsigned. SHA-512 checks verify file integrity against release metadata but do not establish publisher identity.
