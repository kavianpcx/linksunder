# Report history benchmark — v0.4.0

Run date: 2026-11-18. This benchmark used generated local JSON reports in a temporary
directory; it did not read, modify, or delete user reports.

## Environment and method

- Windows 11 Education, build 28000; x64.
- Node.js v24.22.3; Intel Core i7-10700 at 2.90 GHz; 31.9 GiB system memory.
- 100, 10,000, and 100,000 small synthetic report files with two repeated target
  hosts and mixed pass/fail statuses.
- The local SQLite index was built from the JSON files, closed, and reopened. Backend
  page and search timings are p50/p95 of 25 synchronous index queries. The database
  size is measured before deletion.
- The 100,000-record UI run opened the actual development server and page in local
  Chrome. It measured navigation to a 20-row page, typing a host filter that returns
  50,000 records, and moving to page 2. Each UI value is a single observed run.
- Clear-all exercised the shared durable deletion batch path against the generated
  files and index.

## Results

| Reports | Fixture creation | Index build | Index reopen | First page / rows | Middle page p50 / p95 | Search p50 / p95 | RSS before → after index (delta) | SQLite before deletion | Delete all / failures / files left |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 22 ms | 31 ms | 7.413 ms | 0.135 ms / 20 | 0.162 / 0.243 ms | 0.185 / 0.260 ms | 55.0 → 57.5 MiB (+2.5 MiB) | 188,416 B | 46 ms / 0 / 0 |
| 10,000 | 5,411 ms | 2,683 ms | 21.254 ms | 0.701 ms / 20 | 4.647 / 4.885 ms | 1.593 / 2.011 ms | 78.8 → 87.1 MiB (+8.3 MiB) | 14,704,640 B | 5,003 ms / 0 / 0 |
| 100,000 | 69,007 ms | 29,337 ms | 10.250 ms | 6.482 ms / 20 | 54.098 / 61.588 ms | 13.812 / 16.565 ms | 229.8 → 254.6 MiB (+24.8 MiB) | 145,068,032 B | 97,250 ms / 0 / 0 |

At 100,000 reports, the browser showed 20 rows per page. Page navigation took
257.26 ms, filtering to 50,000 reports took 638.30 ms, and moving to page 2 took
716.86 ms. No complete report collection was sent for these ordinary history views.

The process RSS values are observations immediately before and after index
reconciliation, not a peak-memory measurement. The 100,000-report run had a higher
starting RSS after fixture creation, so the incremental value is more useful than a
cross-run comparison of absolute RSS.

## Limits

These are measurements from one Windows computer and one run of the full UI flow;
they are not guarantees for other hardware, file systems, Linux distributions, or
production-sized report payloads. Generated reports are deliberately small. The
100,000-file fixture and clear-all run take about 2.8 minutes together on this
machine. Linux package behavior is verified separately by the release CI matrix.
