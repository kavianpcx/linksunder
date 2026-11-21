# LinkSunder v0.5.2

LinkSunder v0.5.2 improves report history and adds quick reruns for recent resilience tests.

## Highlights

- Added a little space above the report history table so it reads separately from the search and filters.
- Added a Run again action for resilience tests started in this version. It reopens the test builder with the prior URL, steps, values, timeout, and screenshot settings.
- Requires the user to confirm target authorization again before rerunning.
- Maps the existing disruption step when changing between offline, API failure, and slow response tests. Switching to a basic health check clears unused scenario steps.
- Stores recent rerun inputs only in local app storage; they are not included in exported JSON or HTML reports. Removing reports also removes their saved rerun inputs.

Reports created before this feature, API Test Builder reports, and network inspection reports do not contain reusable resilience scenario inputs and cannot be rerun from this action.
