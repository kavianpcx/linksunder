# Security policy

LinkSunder is a local, single-user developer tool. Run only trusted scenarios against
authorized targets. Do not expose the server to a network or use it as a public API.

The app binds to 127.0.0.1, validates Host/Origin, requires a custom mutation header,
limits body size, serializes runs, bounds actions and run duration, disables service
workers and WebSockets, and closes isolated contexts after runs. HTTP(S) requests
are checked, with redirects fetched one hop at a time. Other local origins and
nonpublic targets are blocked for external tests; local targets remain an explicit
developer capability. No arbitrary report paths are accepted through the API.

The Network Inspector requires explicit confirmation for each inspection, handles
one host at a time, and limits the selected TCP ports, concurrency, and connection
timeouts. HTTP checks use `HEAD`, do not save response bodies or cookie values, and
follow only a small number of redirects while the hostname remains unchanged. It
does not authenticate, exploit services, or scan address ranges. Use it only on
systems you own or are explicitly authorized to inspect. Its findings are guidance,
not a vulnerability verdict.

DNS validation is not connection-level pinning; rebinding remains possible. HTTP
routing is not a complete firewall for browser background traffic or WebRTC. Avoid
hostile websites. Do not type production secrets into scenarios. Test names are
user-entered and should not contain secrets. Reports omit field values, raw browser
errors, headers, cookies, bodies, and full URLs. Screenshots are opt-in and mask
inputs/textarea/contenteditable/[data-sensitive] plus custom selectors. Other page
content may still be sensitive. Keep data/ private; encryption at rest is not provided.

For a suspected vulnerability, use
[GitHub's private vulnerability reporting form](https://github.com/kavianpcx/linksunder/security/advisories/new).
Do not put exploit details, secrets, or private reports in a public issue. No
response-time or bounty commitments are made.

The v0.4.0 branch's focused security review, including current production and
development dependency audit status, is recorded in
[docs/security-review-v0.4.0.md](docs/security-review-v0.4.0.md).
