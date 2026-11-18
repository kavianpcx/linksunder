# Scenario guide

## Start with a basic health check

New Test starts as a **Basic Website Health Check** with an empty target field. Enter a
site you own, confirm permission, and run the check. It records the initial HTTP
response, navigation time, document ready state, same-origin failed requests, uncaught
JavaScript errors, and console errors. The report lists each check and its evidence.
This initial page-load check does not test offline recovery or prove resilience. The
bundled demo remains a separate example and is never used as the new target by default.

## Guided resilience tests

Choose **Offline Recovery**, **API Failure**, or **Slow API Response** to open the guided
setup. Give it the visible name of the button or link that sends the request; optionally
provide a labelled form field and a safe test value. For API Failure and Slow API, enter
the exact path (for example `/api/messages`), which can be copied from a health report.
Set the expected visible text for normal behavior, behavior during the disruption, and
behavior after recovery. Slow API also asks for an added delay from 1 to 15,000 ms.

Guided setup creates baseline, disruption, and recovery actions. It does not guess what
your application's correct behavior should be. Review the generated steps, confirm the
target, then run. The Run Resilience Test button stays disabled until a fault, a real
trigger action, matching assertions, and a recovery check are configured. You do not
need to write CSS selectors for the guided flow. The Advanced step editor still supports
CSS selectors and accessible button, link, field-label, or visible-text locators.

For Slow API, set the disruption expectation to a visible loading or timeout message;
the runner waits for the delayed request to finish before checking recovery. A matching
request and an explicit recovery expectation are required for PASS. If the selected API
path is never requested, LinkSunder reports **FAULT NOT TRIGGERED** even if other checks
fail. Cancel closes the active browser context; completed server-side actions cannot be
undone, so use staging and disposable test data.

## Advanced scenario steps

Each step runs in order. Check Element waits for visibility. Check Field Value compares
an input's current value exactly. A resilience scenario needs a baseline request, an
actually triggered disruption, an assertion during the disruption, a recovery request,
and a recovery assertion before it can report PASS. A scenario without a disruption
reports **NOT TESTED**; observation-only steps report **OBSERVED**.

Offline/Online change context connectivity. Fail API Request returns HTTP 503 for
an exact normalized pathname. Delay API Response adds latency before fetching the
response; it is not bandwidth throttling. A run supports one disruption type. Install
the rule before a browser action that triggers the target request. Query strings and
fragments are not used when matching API paths.

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
