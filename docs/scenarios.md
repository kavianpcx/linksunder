# Scenario guide

The initial URL opens automatically. CSS selectors identify elements. Prefer stable
IDs or `data-testid` selectors. Each step runs in order; a failure stops the run.
Check Element waits for visibility. Check Field Value compares an input's current
value exactly. No implicit assertions or health scores are produced. A scenario without
a disruption reports **NOT TESTED**; observation-only steps report **OBSERVED**.

Offline/Online change context connectivity. Fail API Request returns HTTP 503 for
an exact normalized pathname. Delay API Response adds latency before fetching the
response; it is not bandwidth throttling. A run supports one disruption type. Install
the rule before a browser action that triggers the target request. A passing resilience
run also needs a baseline request, an assertion after the fault, a recovery request and
a recovery assertion. If no matching request occurs, the result is **FAULT NOT TRIGGERED**.

Example for the bundled form:

```json
{
  "name": "Preserve draft after API failure",
  "url": "http://127.0.0.1:4317/demo/fixed",
  "type": "failure",
  "steps": [
    { "action": "click", "selector": "#send" },
    { "action": "check", "selector": "#status[data-state='success']" },
    { "action": "fill", "selector": "#note", "value": "Keep this draft" },
    { "action": "fail", "path": "/demo/api/messages" },
    { "action": "click", "selector": "#send" },
    { "action": "check", "selector": "#status[data-state='error']" },
    { "action": "value", "selector": "#note", "value": "Keep this draft" },
    { "action": "online" },
    { "action": "click", "selector": "#send" },
    { "action": "check", "selector": "#status[data-state='success']" }
  ]
}
```

Use the Advanced panel to import/export JSON, change timeouts and add screenshot
masks. Screenshot steps only capture when the screenshot consent checkbox is on.
Never share scenarios containing private test inputs. Cancellation closes Chromium;
already completed target-side actions cannot be undone. Use staging/test data.

## API Test Builder

The dedicated API Test Builder runs GET by default and compares baseline, a selected
client-side fault, and recovery. It supports query parameters, headers, bodies for POST,
PUT and PATCH, expected status/time/header checks, JSON property assertions, and a
limited JSON Schema subset. Up to two retries are available only for GET, HEAD and
OPTIONS. Redirects stop by default; same-origin redirects can be enabled for safe
methods. POST, PUT, PATCH and DELETE require explicit confirmation and are sent once;
they cannot be retried or replayed for a fault test. HTTP 503 and latency simulations
are applied locally at the LinkSunder client boundary and do not change the server.
Request bodies and credentials are never written to reports. JSON previews are temporary
and mask common sensitive field names; text and binary previews are omitted.

## JSON Schema

Generate the versioned schema from the shared Zod schema:

```sh
npm run schema:export
```

The command writes `docs/scenario.schema.json`. Point a JSON-aware editor at that
file to get autocomplete and validation for scenario files. The generated schema
is authoritative; do not edit it by hand.
