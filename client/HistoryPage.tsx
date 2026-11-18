import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, LoaderCircle, Search, Trash2 } from 'lucide-react';
import type { HistoryDeleteJob, HistoryPageData, HistoryRecord, HistorySummary } from '../shared/history';
import { api } from './api';
import { formatRunTimestamp } from './format-run-timestamp';
import { SelectField } from './SelectField';

interface HistoryPageProps {
  summary: HistorySummary;
  onOpenRun: (id: string) => void;
  onOpenNetwork: (id: string) => void;
  onRefresh: () => Promise<void>;
}

type PendingDelete = { type: 'selected'; items: HistoryRecord[] } | { type: 'all'; total: number };

const kindOptions = [
  { value: 'all', label: 'All report types' },
  { value: 'run', label: 'Resilience tests' },
  { value: 'network', label: 'Network inspections' },
];
const statusOptions = [
  { value: 'all', label: 'All results' },
  { value: 'pass', label: 'Passed' },
  { value: 'fail', label: 'Failed' },
  { value: 'observed', label: 'Observed' },
  { value: 'not-tested', label: 'Not tested' },
  { value: 'fault-not-triggered', label: 'Fault not triggered' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'error', label: 'Error' },
];
const statusLabel = (status: string) => ({
  pass: 'PASS', fail: 'FAIL', error: 'ERROR', cancelled: 'CANCELLED',
  observed: 'OBSERVED', 'not-tested': 'NOT TESTED', 'fault-not-triggered': 'FAULT NOT TRIGGERED',
}[status] || status);
const sortOptions = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];
const pageSizeOptions = [10, 20, 50].map((value) => ({ value: String(value), label: `${value} per page` }));

function pageNumbers(page: number, totalPages: number) {
  const values = [...new Set([1, totalPages, page - 2, page - 1, page, page + 1, page + 2])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((left, right) => left - right);
  const result: Array<number | 'gap'> = [];
  values.forEach((value, index) => {
    if (index > 0 && value - values[index - 1] > 1) result.push('gap');
    result.push(value);
  });
  return result;
}

export function HistoryPage({ summary, onOpenRun, onOpenNetwork, onRefresh }: HistoryPageProps) {
  const [data, setData] = useState<HistoryPageData>();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('newest');
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteJob, setDeleteJob] = useState<HistoryDeleteJob>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestSequence = useRef(0);
  const dialogWasOpen = useRef(false);
  const completedJob = useRef<string | undefined>(undefined);

  useEffect(() => { void onRefresh(); }, [onRefresh]);

  const visibleRecords = data?.items ?? [];
  const selectedItems = useMemo(
    () => visibleRecords.filter((item) => selected.includes(`${item.kind}:${item.id}`) && item.status !== 'running'),
    [visibleRecords, selected],
  );
  const deletableVisible = visibleRecords.filter((item) => item.status !== 'running');
  const allVisibleSelected = deletableVisible.length > 0 && deletableVisible.every((item) => selected.includes(`${item.kind}:${item.id}`));

  useEffect(() => {
    let live = true;
    const sequence = ++requestSequence.current;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort });
      if (query.trim()) params.set('q', query.trim());
      if (kind !== 'all') params.set('kind', kind);
      if (status !== 'all') params.set('status', status);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      setLoading(true);
      setError('');
      void api<HistoryPageData>(`/api/history?${params.toString()}`)
        .then((result) => {
          if (!live || sequence !== requestSequence.current) return;
          setData(result);
          setSelected([]);
          if (result.page !== page) setPage(result.page);
        })
        .catch((reason) => {
          if (live && sequence === requestSequence.current) setError((reason as Error).message);
        })
        .finally(() => {
          if (live && sequence === requestSequence.current) setLoading(false);
        });
    }, query.trim() ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [page, pageSize, query, kind, status, from, to, sort, reload]);

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

  useEffect(() => {
    if (!deleteJob || deleteJob.status !== 'running') return;
    let live = true;
    const poll = async () => {
      try {
        const updated = await api<HistoryDeleteJob>(`/api/history/delete-all/${deleteJob.id}`);
        if (!live) return;
        setDeleteJob(updated);
        if (updated.status === 'complete' && completedJob.current !== updated.id) {
          completedJob.current = updated.id;
          setNotice(`Deleted ${updated.deleted} of ${updated.total} reports.${updated.failed ? ` ${updated.failed} could not be removed; their files were preserved.` : ''}`);
          setReload((value) => value + 1);
          void onRefresh();
        }
      } catch (reason) {
        if (live) setError((reason as Error).message);
      }
    };
    const timer = window.setInterval(() => void poll(), 500);
    void poll();
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [deleteJob?.id, deleteJob?.status, onRefresh]);

  function requestDelete(items: HistoryRecord[]) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingDelete({ type: 'selected', items });
  }

  function requestDeleteAll() {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingDelete({ type: 'all', total: summary.resilienceCount + summary.networkCount });
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

  function toggle(item: HistoryRecord) {
    const key = `${item.kind}:${item.id}`;
    setSelected((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]);
  }

  function toggleVisible() {
    const keys = deletableVisible.map((item) => `${item.kind}:${item.id}`);
    setSelected((current) => allVisibleSelected
      ? current.filter((key) => !keys.includes(key))
      : [...new Set([...current, ...keys])]);
  }

  async function confirmDeletion() {
    if (!pendingDelete) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (pendingDelete.type === 'selected') {
        const result = await api<{ deleted: number; failed?: Array<{ id: string; error: string }> }>('/api/history/delete', {
          reports: pendingDelete.items.map(({ id, kind }) => ({ id, kind })),
        });
        setNotice(`${result.deleted} report${result.deleted === 1 ? '' : 's'} deleted from this computer.${result.failed?.length ? ` ${result.failed.length} could not be removed; their files were preserved.` : ''}`);
        setSelected([]);
        setPendingDelete(null);
        setReload((value) => value + 1);
        await onRefresh();
      } else {
        const created = await api<Pick<HistoryDeleteJob, 'id' | 'status' | 'total'>>('/api/history/delete-all', {});
        const initial: HistoryDeleteJob = { ...created, deleted: 0, failed: 0, created: new Date().toISOString(), updated: new Date().toISOString(), failures: [] };
        setDeleteJob(initial);
        setPendingDelete(null);
        if (created.status === 'complete') {
          setNotice(`Deleted 0 of ${created.total} reports.`);
          setReload((value) => value + 1);
          await onRefresh();
        }
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pageCount = data?.totalPages ?? 1;
  const pages = pageNumbers(data?.page ?? page, pageCount);
  const indexing = summary.indexing.status === 'indexing';
  const indexReady = summary.indexing.status === 'complete';
  const jobProgress = deleteJob?.total ? Math.round((deleteJob.deleted + deleteJob.failed) / deleteJob.total * 100) : 100;

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">LOCAL REPORTS</div>
          <h1 id="history-heading" tabIndex={-1}>Reports &amp; history</h1>
          <p>Open, export, search, or remove previous checks stored on this computer.</p>
        </div>
        <button className="secondary" onClick={requestDeleteAll} disabled={!(summary.resilienceCount + summary.networkCount) || !indexReady} title={!indexReady ? 'Available when history indexing finishes' : undefined}>
          <Trash2 size={16} aria-hidden="true" /> Clear all history
        </button>
      </div>
      {error && <div role="alert" className="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {indexing && <p className="notice indexing-notice" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" /> Indexing existing report metadata: {summary.indexing.scanned.toLocaleString()} of {summary.indexing.total.toLocaleString()}. Reports remain on disk during this step.</p>}
      {summary.deletionRecoveryError && <p className="alert" role="alert">{summary.deletionRecoveryError}</p>}
      {deleteJob && <section className="panel delete-progress" aria-live="polite">
        <div><strong>{deleteJob.status === 'complete' ? 'History cleanup finished' : 'Deleting selected history'}</strong><p>{deleteJob.deleted.toLocaleString()} of {deleteJob.total.toLocaleString()} removed · {deleteJob.failed.toLocaleString()} kept because of file errors</p></div>
        {deleteJob.status === 'running' ? <progress max={100} value={jobProgress} aria-label="History deletion progress" /> : <button type="button" className="secondary" onClick={() => setDeleteJob(undefined)}>Dismiss</button>}
      </section>}
      <section className="panel history-panel">
        <div className="panel-head history-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search report history</span>
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search names or hosts…" />
          </label>
          <div className="history-actions">
            <span>{data ? `${data.total.toLocaleString()} reports` : 'Loading reports'}</span>
            <button className="secondary" disabled={!selectedItems.length} onClick={() => requestDelete(selectedItems)}>
              <Trash2 size={15} aria-hidden="true" /> Delete selected ({selectedItems.length})
            </button>
          </div>
        </div>
        <div className="history-filters">
          <SelectField label="Report type" value={kind} options={kindOptions} onChange={(value) => { setKind(value); setPage(1); }} />
          <SelectField label="Result" value={status} options={statusOptions} onChange={(value) => { setStatus(value); setPage(1); }} />
          <SelectField label="Sort" value={sort} options={sortOptions} onChange={(value) => { setSort(value); setPage(1); }} />
          <label>Date from<input aria-label="Date from" type="date" value={from} max={to || undefined} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
          <label>Date to<input aria-label="Date to" type="date" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
        </div>
        {loading && data && <p className="hint" role="status">Loading this page…</p>}
        {!data && !error ? <div className="empty"><LoaderCircle className="spin" size={22} aria-hidden="true" /><p role="status">Loading reports…</p></div> : !data?.total ? (
          <div className="empty">
            <span className="empty-icon"><FileText size={27} /></span>
            <h3>{query || kind !== 'all' || status !== 'all' || from || to ? 'No matching reports' : 'No reports yet'}</h3>
            <p>{query || kind !== 'all' || status !== 'all' || from || to ? 'Try changing your search or filters.' : 'Your resilience tests and network inspections will appear here.'}</p>
          </div>
        ) : !visibleRecords.length ? (
          <div className="empty compact-empty"><h3>No reports on this page</h3><p>Choose another page or search filter.</p></div>
        ) : (
          <>
            <div className="tablewrap">
              <table className="history-table">
                <thead><tr>
                  <th><input aria-label="Select all visible reports" type="checkbox" checked={allVisibleSelected} disabled={!deletableVisible.length} onChange={toggleVisible} /></th>
                  <th>Report</th><th>Type</th><th>Result</th><th>Started</th><th>Actions</th>
                </tr></thead>
                <tbody>{visibleRecords.map((item) => {
                  const key = `${item.kind}:${item.id}`;
                  const format = item.kind === 'run' ? `/api/reports/${item.id}` : `/api/network/reports/${item.id}`;
                  return <tr key={key}>
                    <td><input aria-label={`Select ${item.title}`} type="checkbox" checked={selected.includes(key)} onChange={() => toggle(item)} disabled={item.status === 'running'} /></td>
                    <td>
                      <button className="runlink history-open" onClick={() => item.kind === 'run' ? onOpenRun(item.id) : onOpenNetwork(item.id)}>{item.title}</button>
                      <small>{item.kind === 'run' ? `Resilience test${item.target ? ` · ${item.target}` : ''}` : `Network inspection · ${item.target}`}</small>
                    </td>
                    <td>{item.kind === 'run' ? 'Resilience' : 'Network'}</td>
                    <td><span className={`badge ${item.status}`}>{statusLabel(item.status)}</span></td>
                    <td>{formatRunTimestamp(item.started)}</td>
                    <td className="history-row-actions">
                      {item.status !== 'running' && <>
                        <a className="icon-action" aria-label={`Download JSON for ${item.title}`} data-tooltip="Download JSON" href={`${format}/json`}><Download size={16} aria-hidden="true" /></a>
                        <a className="icon-action" aria-label={`Download HTML for ${item.title}`} data-tooltip="Download HTML" href={`${format}/html`}><FileText size={16} aria-hidden="true" /></a>
                      </>}
                      <button className="icon-action danger-action" aria-label={`Delete report ${item.title}`} data-tooltip="Delete report" onClick={() => requestDelete([item])} disabled={item.status === 'running'}><Trash2 size={16} aria-hidden="true" /></button>
                    </td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <div className="history-pagination">
              <span>Page {data?.page ?? page} of {pageCount} · {data?.total.toLocaleString()} reports</span>
              <nav aria-label="History pages">
                <button type="button" className="page-button" aria-label="Previous page" disabled={(data?.page ?? page) <= 1 || loading} onClick={() => setPage((data?.page ?? page) - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
                {pages.map((value, index) => value === 'gap'
                  ? <span className="page-gap" key={`gap-${index}`} aria-hidden="true">…</span>
                  : <button type="button" className={value === (data?.page ?? page) ? 'page-button current' : 'page-button'} aria-label={`Page ${value}`} aria-current={value === (data?.page ?? page) ? 'page' : undefined} key={value} disabled={loading} onClick={() => setPage(value)}>{value}</button>)}
                <button type="button" className="page-button" aria-label="Next page" disabled={(data?.page ?? page) >= pageCount || loading} onClick={() => setPage((data?.page ?? page) + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
              </nav>
              <SelectField ariaLabel="History page size" value={String(pageSize)} options={pageSizeOptions} onChange={(value) => { setPageSize(Number(value)); setPage(1); }} />
            </div>
          </>
        )}
      </section>
      {pendingDelete && (
        <div className="modal-scrim">
          <section ref={dialogRef} className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-history-title" aria-describedby="delete-history-description" tabIndex={-1} onKeyDown={handleDialogKeyDown}>
            <div className="modal-icon"><Trash2 size={22} aria-hidden="true" /></div>
            <h2 id="delete-history-title">{pendingDelete.type === 'all' ? `Delete all ${pendingDelete.total.toLocaleString()} reports?` : `Delete ${pendingDelete.items.length} selected report${pendingDelete.items.length === 1 ? '' : 's'}?`}</h2>
            <p id="delete-history-description">This removes report files from local history. Download any report you want to keep first. Active checks are kept. Large deletions continue in the background and can safely resume after LinkSunder restarts.</p>
            {pendingDelete.type === 'all' && !indexReady && <p className="hint">Wait until history indexing finishes so every existing report is included.</p>}
            <div className="buttons">
              <button ref={cancelButton} className="secondary" onClick={() => setPendingDelete(null)} disabled={busy}>Cancel</button>
              <button className="danger-button" onClick={() => void confirmDeletion()} disabled={busy || (pendingDelete.type === 'all' && !indexReady)}>{busy ? 'Preparing…' : pendingDelete.type === 'all' ? 'Delete all reports' : 'Delete reports'}</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
