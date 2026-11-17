# Scenario guide

The initial URL opens automatically. CSS selectors identify elements. Prefer stable
IDs or `data-testid` selectors. Each step runs in order; a failure stops the run.
Check Element waits for visibility. Check Field Value compares an input's current
value exactly. No implicit assertions or health scores are produced.

Offline/Online change context connectivity. Fail API Request returns HTTP 503 for
matching pathname substrings. Delay API Response adds the specified milliseconds
before fetching the response; it is not bandwidth throttling. The most recently
configured API rule replaces the previous rule for that run. Rules affect future
requests, so install a rule before clicking the action that triggers the API.

Example for the bundled form:

```json
{
  "name": "Preserve draft after API failure",
  "url": "http://127.0.0.1:4317/demo/fixed",
  "type": "failure",
  "steps": [
    { "action": "fill", "selector": "#note", "value": "Keep this draft" },
    { "action": "fail", "path": "/demo/api/messages" },
    { "action": "click", "selector": "#send" },
    { "action": "check", "selector": "#status[data-state='error']" },
    { "action": "value", "selector": "#note", "value": "Keep this draft" }
  ]
}
```

Use the Advanced panel to import/export JSON, change timeouts and add screenshot
masks. Screenshot steps only capture when the screenshot consent checkbox is on.
Never share scenarios containing private test inputs. Cancellation closes Chromium;
already completed target-side actions cannot be undone. Use staging/test data.

## JSON Schema

Generate the versioned schema from the shared Zod schema:

```sh
npm run schema:export
```

The command writes `docs/scenario.schema.json`. Point a JSON-aware editor at that
file to get autocomplete and validation for scenario files. The generated schema
is authoritative; do not edit it by hand.
