import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Download, FileText, Search, Trash2 } from 'lucide-react';
import type { NetworkReport } from '../shared/network';
import type { Run } from '../shared/schema';
import { api } from './api';
import { formatRunTimestamp } from './format-run-timestamp';

type HistoryItem =
  | { kind: 'run'; id: string; title: string; started: string; status: string; subtitle: string; run: Run }
  | { kind: 'network'; id: string; title: string; started: string; status: string; subtitle: string; network: NetworkReport };

interface HistoryPageProps {
  runs: Run[];
  networkReports: NetworkReport[];
  onOpenRun: (run: Run) => void;
  onOpenNetwork: (report: NetworkReport) => void;
  onRefresh: () => Promise<void>;
}

export function HistoryPage({ runs, networkReports, onOpenRun, onOpenNetwork, onRefresh }: HistoryPageProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<HistoryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogWasOpen = useRef(false);

  const allItems: HistoryItem[] = useMemo(() => [
    ...runs.map((run): HistoryItem => ({
      kind: 'run', id: run.id, title: run.name, started: run.started, status: run.status,
      subtitle: `Resilience test · ${run.type}`, run,
    })),
    ...networkReports.map((report): HistoryItem => ({
      kind: 'network', id: report.id, title: report.hostname, started: report.started, status: report.status,
      subtitle: `Network inspection · ${report.target}`, network: report,
    })),
  ].sort((left, right) => Date.parse(right.started) - Date.parse(left.started)), [runs, networkReports]);

  const filtered = allItems.filter((item) =>
    `${item.title} ${item.subtitle} ${item.status}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const deletableItems = allItems.filter((item) => item.status !== 'running');
  const deletableFiltered = filtered.filter((item) => item.status !== 'running');
  const selectedItems = deletableItems.filter((item) => selected.includes(`${item.kind}:${item.id}`));
  const keyOf = (item: HistoryItem) => `${item.kind}:${item.id}`;
  const allVisibleSelected = deletableFiltered.length > 0 && deletableFiltered.every((item) => selected.includes(keyOf(item)));

  useEffect(() => {
    if (pendingDelete) {
      dialogWasOpen.current = true;
      cancelButton.current?.focus();
    } else if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      else document.getElementById('history-heading')?.focus();
    }
  }, [pendingDelete]);

  function requestDelete(items: HistoryItem[]) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingDelete(items);
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !busy) {
      setPendingDelete(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggle(item: HistoryItem) {
    const key = keyOf(item);
    setSelected((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]);
  }

  function toggleVisible() {
    const visibleKeys = deletableFiltered.map(keyOf);
    setSelected((current) => allVisibleSelected
      ? current.filter((key) => !visibleKeys.includes(key))
      : [...new Set([...current, ...visibleKeys])]);
  }

  async function deleteSelected(items: HistoryItem[]) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ deleted: number }>('/api/history/delete', {
        reports: items.map(({ id, kind }) => ({ id, kind })),
      });
      setPendingDelete(null);
      setSelected([]);
      setNotice(`${result.deleted} report${result.deleted === 1 ? '' : 's'} deleted from this computer.`);
      await onRefresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">LOCAL REPORTS</div>
        <h1 id="history-heading" tabIndex={-1}>Reports &amp; history</h1>
          <p>Open, export, search, or remove previous checks stored on this computer.</p>
        </div>
        <button className="secondary" onClick={() => requestDelete(deletableItems)} disabled={!deletableItems.length}>
          <Trash2 size={16} /> Clear all history
        </button>
      </div>
      {error && <div role="alert" className="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {notice && <p role="status" className="notice">{notice}</p>}
      <section className="panel history-panel">
        <div className="panel-head history-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search report history</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search reports…" />
          </label>
          <div className="history-actions">
            <span>{filtered.length} of {allItems.length} reports</span>
            <button className="secondary" disabled={!selectedItems.length} onClick={() => requestDelete(selectedItems)}>
              <Trash2 size={15} /> Delete selected ({selectedItems.length})
            </button>
          </div>
        </div>
        {!allItems.length ? (
          <div className="empty">
            <span className="empty-icon"><FileText size={27} /></span>
            <h3>No reports yet</h3>
            <p>Your resilience test and network inspection reports will appear here.</p>
          </div>
        ) : !filtered.length ? (
          <div className="empty compact-empty"><h3>No matching reports</h3><p>Try another target or report name.</p></div>
        ) : (
          <div className="tablewrap">
            <table className="history-table">
              <thead><tr>
                <th><input aria-label="Select all visible reports" type="checkbox" checked={allVisibleSelected} disabled={!deletableFiltered.length} onChange={toggleVisible} /></th>
                <th>Report</th><th>Type</th><th>Result</th><th>Started</th><th>Actions</th>
              </tr></thead>
              <tbody>{filtered.map((item) => {
                const key = keyOf(item);
                const format = item.kind === 'run' ? `/api/reports/${item.id}` : `/api/network/reports/${item.id}`;
                return <tr key={key}>
                  <td><input aria-label={`Select ${item.title}`} type="checkbox" checked={selected.includes(key)} onChange={() => toggle(item)} disabled={item.status === 'running'} /></td>
                  <td>
                    <button className="runlink history-open" onClick={() => item.kind === 'run' ? onOpenRun(item.run) : onOpenNetwork(item.network)}>
                      {item.title}
                    </button>
                    <small>{item.subtitle}</small>
                  </td>
                  <td>{item.kind === 'run' ? 'Resilience' : 'Network'}</td>
                  <td><span className={`badge ${item.status}`}>{item.status}</span></td>
                  <td>{formatRunTimestamp(item.started)}</td>
                  <td className="history-row-actions">
                    {item.status !== 'running' && <>
                      <a className="icon-action" aria-label={`Download JSON for ${item.title}`} data-tooltip="Download JSON" href={`${format}/json`}><Download size={16} /></a>
                      <a className="icon-action" aria-label={`Download HTML for ${item.title}`} data-tooltip="Download HTML" href={`${format}/html`}><FileText size={16} /></a>
                    </>}
                    <button className="icon-action danger-action" aria-label={`Delete report ${item.title}`} data-tooltip="Delete report" onClick={() => requestDelete([item])} disabled={item.status === 'running'}><Trash2 size={16} /></button>
                  </td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </section>
      {pendingDelete && (
        <div className="modal-scrim">
          <section ref={dialogRef} className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-history-title" aria-describedby="delete-history-description" tabIndex={-1} onKeyDown={handleDialogKeyDown}>
            <div className="modal-icon"><Trash2 size={22} /></div>
            <h2 id="delete-history-title">Delete {pendingDelete.length} report{pendingDelete.length === 1 ? '' : 's'}?</h2>
            <p id="delete-history-description">This permanently removes the selected report files from local history. Download any report you want to keep before deleting it.</p>
            {allItems.some((item) => item.status === 'running') && <p className="hint">Checks still in progress are excluded and cannot be deleted.</p>}
            <div className="buttons">
              <button ref={cancelButton} className="secondary" onClick={() => setPendingDelete(null)} disabled={busy}>Cancel</button>
              <button className="danger-button" onClick={() => void deleteSelected(pendingDelete)} disabled={busy}>{busy ? 'Deleting…' : 'Delete reports'}</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
