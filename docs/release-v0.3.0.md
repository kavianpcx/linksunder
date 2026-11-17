# LinkSunder v0.3.0 — desktop applications

LinkSunder v0.3.0 adds a real Network Inspector and a unified, searchable reports
history to the full Windows and Linux desktop application. Reports can be opened,
exported as JSON or standalone HTML, and removed after confirmation. Settings now
support a chosen reports folder with verified copy migration and persistent local
preferences.

The interface now uses accessible custom dropdowns with keyboard navigation,
typeahead, theme-aware menus and focus states. Dark and light scrollbars, form
controls, number steppers, tooltips, confirmation dialogs and responsive layouts
follow the same design system. The Windows/Linux desktop title bar and app controls
are integrated into the interface.

## Network Inspector boundaries

Inspect only systems you own or have explicit permission to assess. Each inspection
requires confirmation and is limited to one host, up to 20 selected TCP ports, four
parallel TCP connections, and short connection timeouts. HTTP requests use `HEAD`
and follow no more than five redirects while the hostname stays the same. Query
strings and fragments are removed before checking; response bodies, credentials and
cookie values are not saved. TLS output is a basic certificate summary. Findings
describe observations and possible next steps; they are not a vulnerability verdict.

## Downloads

- Windows x64 installer: `LinkSunder-0.3.0-Windows-x64.exe`
- Windows x64 portable package: `LinkSunder-0.3.0-Windows-x64.zip`
- Linux x64 Debian package: `LinkSunder-0.3.0-Linux-amd64.deb`
- Linux x64 AppImage: `LinkSunder-0.3.0-Linux-x86_64.AppImage`
- `SHA256SUMS.txt` contains checksums for the four packages.

The installers are not signed with a commercial code-signing certificate. Follow
your organization's software policy and do not disable operating-system protections.
No Android APK or hosted iOS PWA is included; the supported product scope remains
Windows and Linux desktop.

## Community contributions

Thank you to **@Golden007-prog** for the timestamp formatting contribution through
[PR #4](https://github.com/kavianpcx/linksunder/pull/4).

Thank you to **@joshuaallgaier2-cmd** for the Duplicate Step contribution in
[PR #6](https://github.com/kavianpcx/linksunder/pull/6) and the JSON Schema
contribution in [PR #7](https://github.com/kavianpcx/linksunder/pull/7). Follow-up
integration fixes for those contributions were completed through [PR #10](https://github.com/kavianpcx/linksunder/pull/10)
and [PR #11](https://github.com/kavianpcx/linksunder/pull/11).
