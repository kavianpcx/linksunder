# Security policy

Version 0.1.x is an early local developer tool. Run only trusted scenarios against
authorized targets. Do not expose the server to a network or use it as a public API.

The app binds to 127.0.0.1, validates Host/Origin, requires a custom mutation header,
limits body size, serializes runs, bounds actions and run duration, disables service
workers and WebSockets, and closes isolated contexts after runs. HTTP(S) requests
are checked, with redirects fetched one hop at a time. Other local origins and
nonpublic targets are blocked for external tests; local targets remain an explicit
developer capability. No arbitrary report paths are accepted through the API.

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
