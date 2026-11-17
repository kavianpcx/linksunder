# ◇ LinkSunder

**Break the connection. Find the bugs. Build a better web.**

A local, open-source resilience lab for websites you own. Build a browser scenario,
disconnect the network, fail an API, or delay selected requests — then check whether
your UI preserves the state that matters. No account, cloud service, or AI API.

### Download the application

**[⬇ Download for Windows — EXE installer](https://github.com/kavianpcx/linksunder/releases/download/v0.2.0/LinkSunder-0.2.0-Windows-x64.exe)** · **[⬇ Download for Linux — DEB installer](https://github.com/kavianpcx/linksunder/releases/download/v0.2.0/LinkSunder-0.2.0-Linux-amd64.deb)**

**Download → Install → Open LinkSunder.** No terminal commands or developer tools required.
On Windows, open the downloaded EXE, finish installation, then open LinkSunder from Start or the desktop shortcut.

[راهنمای فارسی](README.fa.md) · [Scenarios](docs/scenarios.md) · [Security](SECURITY.md)

![Real dashboard after running both demo scenarios](docs/screenshots/dashboard.png)

## Download and open — no terminal

**[Download LinkSunder for your computer](https://github.com/kavianpcx/linksunder/releases/latest)**

LinkSunder is a desktop application, with the real test engine included. Users do
not install Node.js, npm, Git or Playwright and do not type commands to start it.
There is no trial mode, demo-only edition, account or paid feature gate.

| Platform                             | File                                                                                                                         | What to do                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Windows 11, x64                      | [Download EXE installer](https://github.com/kavianpcx/linksunder/releases/download/v0.2.0/LinkSunder-0.2.0-Windows-x64.exe)  | Open the installer, finish installation, then open LinkSunder from Start or the desktop shortcut.                     |
| Windows, x64 portable                | [Download ZIP](https://github.com/kavianpcx/linksunder/releases/download/v0.2.0/LinkSunder-0.2.0-Windows-x64.zip)            | Extract the entire folder and open `LinkSunder.exe`. Keep its resources beside it.                                    |
| Ubuntu / Debian desktop, x64         | [Download DEB installer](https://github.com/kavianpcx/linksunder/releases/download/v0.2.0/LinkSunder-0.2.0-Linux-amd64.deb)  | Open it in the system software installer, install, then launch LinkSunder from Applications.                          |
| Other compatible Linux desktops, x64 | [Download AppImage](https://github.com/kavianpcx/linksunder/releases/download/v0.2.0/LinkSunder-0.2.0-Linux-x86_64.AppImage) | Allow execution in file Properties, then double-click. System library/FUSE compatibility depends on the distribution. |

The desktop packages include the application runtime and test Chromium. They start
their engine automatically on loopback and stop it when the window closes. The
engine never needs to be started by the user. Reports are saved in application
data, outside the installation folder, and can be downloaded to any chosen folder.
The installer does not remove reports on uninstall. Installers currently have no
commercial code-signing certificate; follow your organization's publisher policy.
Do not disable operating-system protections to run a download.

**Android and iOS:** no APK, native mobile app or hosted iOS PWA is shipped. The
current product scope is Windows and Linux desktop, following the owner's clarified
requirements. A responsive UI does not mean a standalone mobile test engine exists.

### First test

1. Open LinkSunder and select **New Test**.
2. Enter the address of a website you own, choose your steps and expected result.
3. Select **Run Test**, inspect the timeline, then **Download Report**.
4. Use **Save scenario** to reuse it later. Saved scenarios may contain your test inputs.

The optional **Run Demo** button is a guided example inside the full application,
not a restriction on testing your own sites. There are no pre-filled fake results.

<details>
<summary>For developers only: build and run from source</summary>

## Build from source

Requires **Node.js 22.12+** (24 LTS recommended), npm, and Git.

```sh
git clone https://github.com/kavianpcx/linksunder.git
cd linksunder
npm install
npm run setup
npm run dev
```

Open **http://127.0.0.1:4317** and click **Run Demo**. Setup verifies an existing
Chrome/Edge installation on Windows, or downloads Playwright Chromium. On Linux,
install Playwright's documented OS prerequisites if missing (`npx playwright install --with-deps chromium`).
If the browser CDN is unavailable, set `LINKSUNDER_BROWSER` to an installed Chromium
executable before setup and startup. No administrator rights are required by this app.

For a production build: `npm run build`, then `npm run start`.

</details>

## Demo: the same failure, two different outcomes

The bundled note form has two implementations. A real Chromium session fills a
draft, goes offline, clicks Send, waits for the error state, and checks the field.

| Scenario | Expected evidence                                           |
| -------- | ----------------------------------------------------------- |
| Broken   | FAIL: the form clears the draft before the request succeeds |
| Fixed    | PASS: the draft survives the failed send and reconnection   |

The demo uses no external service. Its two results are saved to your real history.

![Actual test report](docs/screenshots/report.png)

## Features

- A responsive dashboard with dark/light themes, real history, and one active run.
- Ordered no-code steps: open, click, fill, offline, online, fail/delay API, check
  element/value, and screenshot. Add, edit, remove, or reorder; import/export JSON.
- Chromium network emulation and controlled HTTP 503 responses.
- Opt-in masked screenshots, cancellation, bounded timeouts, and isolated contexts.
- Self-contained offline HTML reports and JSON exports, persisted locally.
- No assertion means **OBSERVED**, never PASS. Failed assertions produce FAIL;
  setup/action errors produce ERROR, and stopped runs produce CANCELLED.

## How it works

The local API validates a scenario, opens an isolated headless Chromium context,
applies network rules, executes ordered steps, and evaluates explicit assertions.
Step status is polled by the dashboard; no synthetic progress percentages are used.
Runs are persisted in `data/` as JSON and standalone HTML with embedded PNGs.

API fault rules apply to subsequent requests whose pathname contains the configured
path. Delays affect selected HTTP requests, **not** mobile bandwidth, packet loss,
or a complete carrier network. Add a Click/Open step after installing an API rule
to trigger a request. A Quick Scan only changes network state and records observations;
it does not infer whether an application is healthy.

## Architecture

```text
client/   React + TypeScript dashboard, served through Vite in development
server/   Fastify API, Playwright runner, policy and report generation
shared/   Zod scenario schema and shared result types
demo/     Deliberately broken and corrected local form
tests/    Unit, browser integration and dashboard E2E tests
docs/     Scenarios, screenshots, release notes and launch drafts
```

The server binds only to `127.0.0.1`. The dashboard, API and demo share one port.
`PORT` changes it. `LINKSUNDER_DATA` selects a report directory; it is an operator
environment setting, never a path accepted from a browser request.

## Safety and limits

Use only on sites you own or have authorization to test. External targets require
explicit consent. HTTP(S) targets only; embedded URL credentials are rejected.
Other loopback origins, private and metadata IPs are blocked during external tests.
Requests and redirects are checked; service workers and WebSockets are disabled.
No saved browser profile, telemetry, request-body/header/cookie logging, or cloud upload.
Form fields and `[data-sensitive]` elements are masked in opt-in screenshots;
add extra selectors for other sensitive content. Scenario JSON may contain your
test inputs — protect it. Treat all reports and screenshots as private.

This is a trusted, single-user developer tool, **not a sandbox for hostile sites**.
DNS checks are not connection-level IP pinning and cannot eliminate DNS rebinding.
Browser background traffic, WebRTC and arbitrary third-party page behavior are not
fully sandboxed by HTTP routing. See [SECURITY.md](SECURITY.md) before external tests.
Scenarios can be saved on this computer or imported/exported as files; there is no browser recorder,
authentication flow, or automatic repair advice beyond
rule-based suggestions. English UI; Persian documentation included.

## Compared with existing tools

| Tool             | Best fit                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| Browser DevTools | Manual network inspection and throttling in an interactive session              |
| Playwright       | Code-first browser automation with arbitrary assertions                         |
| LinkSunder       | A small local UI for repeatable network-failure scenarios and portable evidence |

LinkSunder uses Playwright; it complements these tools and does not replace their flexibility.
References: [Chrome network tools](https://developer.chrome.com/docs/devtools/network/),
[Playwright network routing](https://playwright.dev/docs/network).

## Development and contributing

```sh
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

`npm test` includes real browser integration tests; run setup first. E2E tests use
fresh subdirectories in `.e2e-data/` and write real screenshots to `docs/screenshots/`.
Stop the development server before E2E tests (they own port 4317). CI covers checks on
Linux and Windows. Anyone can fork the project and propose changes without upstream
write access; see [CONTRIBUTING.md](CONTRIBUTING.md) for the step-by-step guide and
the [roadmap](docs/roadmap.md) for planned work.

## License

[MIT](LICENSE). Contributions welcome.

## Original project

LinkSunder is an open-source project originally maintained by
[kavianpcx](https://github.com/kavianpcx). If you are using a fork, please refer
to the [official upstream repository](https://github.com/kavianpcx/linksunder)
for the original project and updates. Linking back to the upstream project is
appreciated.
