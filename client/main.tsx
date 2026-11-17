import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Download,
  FlaskConical,
  LayoutDashboard,
  ListChecks,
  FolderOpen,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Moon,
  Plus,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import {
  actions,
  MAX_SCENARIO_STEPS,
  scenarioSchema,
  type Scenario,
  type Step,
  type Run,
} from '../shared/schema';
import { formatRunTimestamp } from './format-run-timestamp';
import { api } from './api';
import { HistoryPage } from './HistoryPage';
import { NetworkInspector } from './NetworkInspector';
import { SelectField } from './SelectField';
import { NumberField } from './NumberField';
import type { NetworkReport } from '../shared/network';
import './style.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
const labels: Record<string, string> = {
  open: 'Open Page',
  click: 'Click Element',
  fill: 'Fill Field',
  offline: 'Go Offline',
  online: 'Go Online',
  fail: 'Fail API Request',
  delay: 'Delay API Response',
  check: 'Check Element',
  value: 'Check Field Value',
  screenshot: 'Take Screenshot',
};
const actionOptions = actions.map((action) => ({ value: action, label: labels[action] }));
const testTypeOptions = [
  { value: 'offline', label: 'Offline Recovery' },
  { value: 'failure', label: 'API Failure' },
  { value: 'slow', label: 'Slow API Response' },
];
const appearanceOptions = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];
const initial = () =>
  scenarioSchema.parse({
    name: 'Untitled resilience test',
    url: window.location.origin + '/demo/fixed',
    timeout: Number(localStorage.getItem('timeout') || 10000),
    screenshots: localStorage.getItem('defaultScreenshots') === 'true',
  });
function App() {
  const [view, setView] = useState('dashboard');
  const [runs, setRuns] = useState<Run[]>([]);
  const [networkReports, setNetworkReports] = useState<NetworkReport[]>([]);
  const [selected, setSelected] = useState<Run>();
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkReport>();
  const [scenario, setScenario] = useState<Scenario>(initial);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [timeout, setTimeoutValue] = useState(Number(localStorage.getItem('timeout') || 10000));
  const [defaultScreenshots, setDefaultScreenshots] = useState(localStorage.getItem('defaultScreenshots') === 'true');
  const [json, setJson] = useState('');
  const [nextDemo, setNextDemo] = useState<Scenario>();
  const [savedScenarios, setSavedScenarios] = useState<Scenario[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('scenarios') || '[]');
      return Array.isArray(saved)
        ? saved
            .filter((s) => scenarioSchema.safeParse(s).success)
            .map((s) => scenarioSchema.parse(s))
        : [];
    } catch {
      return [];
    }
  });
  const [savedScenarioName, setSavedScenarioName] = useState('');
  const [notice, setNotice] = useState('');
  const [reportDirectory, setReportDirectory] = useState('Local report storage');
  const [damagedReports, setDamagedReports] = useState(0);
  const [storageDraft, setStorageDraft] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const [storageBusy, setStorageBusy] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const refreshHistory = useCallback(async () => {
    try {
      const [nextRuns, nextNetwork] = await Promise.all([
        api<Run[]>('/api/runs'),
        api<NetworkReport[]>('/api/network/reports'),
      ]);
      setRuns(nextRuns);
      setNetworkReports(nextNetwork);
      setSelectedNetwork((current) => current && !nextNetwork.some((report) => report.id === current.id) ? undefined : current);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);
  const onNetworkReportChange = useCallback((report?: NetworkReport) => setSelectedNetwork(report), []);
  useEffect(() => {
    api<{ reportDirectory: string; damagedReports?: number }>('/api/info')
      .then((info) => {
        setReportDirectory(info.reportDirectory);
        setStorageDraft(info.reportDirectory);
        setDamagedReports(info.damagedReports || 0);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const bridge = window.linksunderDesktop;
    if (!bridge) return;
    void bridge.isMaximized().then(setWindowMaximized);
    return bridge.onWindowState(setWindowMaximized);
  }, []);
  function saveScenario() {
    const result = scenarioSchema.safeParse(scenario);
    if (!result.success) {
      setError('Enter a scenario name, valid URL and valid settings before saving.');
      return;
    }
    const next = [...savedScenarios.filter((s) => s.name !== result.data.name), result.data];
    localStorage.setItem('scenarios', JSON.stringify(next));
    setSavedScenarios(next);
    setSavedScenarioName(result.data.name);
    setNotice('Scenario saved on this computer.');
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  useEffect(() => {
    void refreshHistory();
    const timer = window.setInterval(() => void refreshHistory(), 1200);
    return () => {
      clearInterval(timer);
    };
  }, [refreshHistory]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const poll = async () => {
      try {
        const r = await api<Run>('/api/runs/' + selected.id);
        if (live) setSelected(r);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    const timer = window.setInterval(poll, 650);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected?.id]);
  useEffect(() => {
    if (selected && selected.status !== 'running' && nextDemo) {
      const next = nextDemo;
      setNextDemo(undefined);
      void (async () => {
        for (let i = 0; i < 10; i++) {
          try {
            const r = await api<Run>('/api/runs', next);
            setSelected(r);
            return;
          } catch (e) {
            if (!(e as Error).message.includes('active')) {
              setError((e as Error).message);
              return;
            }
            await new Promise((r) => window.setTimeout(r, 250));
          }
        }
        setError('Demo could not start its second run.');
      })();
    }
  }, [selected?.status, nextDemo]);
  async function perform(fn: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  function downloadJson() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scenario.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  async function runDemo() {
    await perform(async () => {
      const d = await api<{ id: string; next: Scenario }>('/api/demo', {});
      setNextDemo(d.next);
      setSelected(await api<Run>('/api/runs/' + d.id));
      setView('result');
    });
  }
  async function useReportFolder(candidate = storageDraft) {
    setStorageBusy(true);
    setStorageNotice('');
    setStorageError('');
    try {
      const result = await api<{ reportDirectory: string; copied: number; total: number; originalsKept?: boolean }>(
        '/api/settings/report-directory',
        { path: candidate },
      );
      setReportDirectory(result.reportDirectory);
      setStorageDraft(result.reportDirectory);
      setStorageNotice(
        result.copied
          ? `Storage changed. ${result.copied} of ${result.total} report files copied and verified. The original files were kept.`
          : 'Storage folder updated. Existing report files were kept.',
      );
      await refreshHistory();
    } catch (reason) {
      setStorageError((reason as Error).message);
    } finally {
      setStorageBusy(false);
    }
  }
  async function browseReportFolder() {
    const bridge = window.linksunderDesktop;
    if (!bridge) {
      setStorageError('Use the folder picker in the installed desktop app, or enter an absolute folder path above.');
      return;
    }
    try {
      const selectedPath = await bridge.chooseReportDirectory();
      if (selectedPath) {
        setStorageDraft(selectedPath);
        await useReportFolder(selectedPath);
      }
    } catch (reason) {
      setStorageError((reason as Error).message);
    }
  }
  async function openReportFolder() {
    try {
      const result = await window.linksunderDesktop?.openReportDirectory();
      if (result && !result.ok) setStorageError(result.error || 'The report folder could not be opened.');
    } catch (reason) {
      setStorageError((reason as Error).message || 'The report folder could not be opened.');
    }
  }
  function resetPreferences() {
    setTheme('dark');
    setTimeoutValue(10000);
    setDefaultScreenshots(false);
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('timeout', '10000');
    localStorage.setItem('defaultScreenshots', 'false');
    setNotice('Default appearance and test preferences restored. Reports and storage location were not changed.');
  }
  useEffect(() => {
    localStorage.setItem('defaultScreenshots', String(defaultScreenshots));
  }, [defaultScreenshots]);
  const active = runs.some((r) => r.status === 'running') || networkReports.some((report) => report.status === 'running');
  const lastCheck = [...runs.map((run) => ({ started: run.started, status: run.status })), ...networkReports.map((report) => ({ started: report.started, status: report.status }))]
    .sort((left, right) => Date.parse(right.started) - Date.parse(left.started))[0];
  const stats = [
    ['Resilience tests', runs.length],
    ['Network inspections', networkReports.length],
    ['Passed tests', runs.filter((r) => r.status === 'pass').length],
    ['Last check', lastCheck?.status.toUpperCase() || 'NO CHECKS'],
  ];
  const updateStep = (i: number, patch: Partial<Step>) =>
    setScenario({
      ...scenario,
      steps: scenario.steps.map((s, j) => (i === j ? { ...s, ...patch } : s)),
    });
  const move = (i: number, d: number) => {
    const steps = [...scenario.steps];
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    setScenario({ ...scenario, steps });
  };
  return (
    <>
      {window.linksunderDesktop && (
        <div className="window-chrome" onDoubleClick={() => void window.linksunderDesktop?.toggleMaximize().then(setWindowMaximized)}>
          <span className="window-app-title"><span className="window-app-mark"><WifiOff size={14} /></span>LinkSunder <span>Resilience workspace</span></span>
          <div className="window-controls" role="toolbar" aria-label="Window controls">
            <button type="button" aria-label="Minimize window" data-tooltip="Minimize" onDoubleClick={(event) => event.stopPropagation()} onClick={() => window.linksunderDesktop?.minimize()}><Minus size={16} /></button>
            <button type="button" aria-label={windowMaximized ? 'Restore window' : 'Maximize window'} data-tooltip={windowMaximized ? 'Restore' : 'Maximize'} onDoubleClick={(event) => event.stopPropagation()} onClick={() => void window.linksunderDesktop?.toggleMaximize().then(setWindowMaximized)}>{windowMaximized ? <Minimize2 size={15} /> : <Maximize2 size={14} />}</button>
            <button type="button" className="window-close" aria-label="Close window" data-tooltip="Close" onDoubleClick={(event) => event.stopPropagation()} onClick={() => window.linksunderDesktop?.close()}><X size={17} /></button>
          </div>
        </div>
      )}
    <div className={window.linksunderDesktop ? 'app app-desktop' : 'app'}>
      <aside>
        <a className="brand" href="#" onClick={() => setView('dashboard')}>
          <span className="brandmark">
            <WifiOff size={20} />
          </span>
          LinkSunder<span className="version">v{__LINKSUNDER_VERSION__}</span>
        </a>
        <div className="workspace">
          LOCAL WORKSPACE <span>●</span>
        </div>
        <nav>
          <button
            className={view === 'dashboard' ? 'nav active' : 'nav'}
            onClick={() => setView('dashboard')}
          >
            <LayoutDashboard size={17} /> Overview
          </button>
          <button
            className={view === 'create' ? 'nav active' : 'nav'}
            onClick={() => setView('create')}
          >
            <FlaskConical size={17} /> New test
          </button>
          <button
            className={view === 'history' ? 'nav active' : 'nav'}
            onClick={() => setView('history')}
          >
            <ListChecks size={17} /> Reports &amp; history
          </button>
          <button
            className={view === 'network' ? 'nav active' : 'nav'}
            onClick={() => setView('network')}
          >
            <Network size={17} /> Network Inspector
          </button>
          <button
            className={view === 'settings' ? 'nav active' : 'nav'}
            onClick={() => setView('settings')}
          >
            <Settings size={17} /> Settings
          </button>
        </nav>
        <div className="aside-bottom">
          <ShieldCheck size={19} />
          <strong>Your machine. Your data.</strong>
          <p>
            No cloud. No account.
            <br />
            Just a more resilient web.
          </p>
          <button className="subtle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}{' '}
            {theme === 'dark' ? 'Light' : 'Dark'} appearance
          </button>
        </div>
      </aside>
      <main>
        <header>
          <span>
            Workspace <ChevronRight size={14} />{' '}
            {view === 'dashboard'
              ? 'Overview'
              : view === 'create'
                ? 'New test'
                : view === 'settings'
                  ? 'Settings'
                : view === 'history'
                  ? 'Reports & history'
                  : view === 'network'
                    ? 'Network Inspector'
                    : view === 'network-report'
                      ? 'Network report'
                  : 'Run details'}
          </span>
          <small>
            <i /> Local engine · Chromium
          </small>
        </header>
        <div className="content">
          {error && (
            <div role="alert" className="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {view === 'dashboard' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">RESILIENCE WORKSPACE</div>
                  <h1>Build for the unexpected.</h1>
                  <p>Break the connection. Find the bugs. Build a better web.</p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setScenario({ ...initial(), timeout });
                    setSavedScenarioName('');
                    setView('create');
                  }}
                >
                  <Plus size={17} /> New Test
                </button>
              </div>
              <section className="hero">
                <div>
                  <span className="pill">THE CONNECTION ISN’T ALWAYS PERFECT</span>
                  <h2>
                    Will your app hold up
                    <br />
                    when the network won’t?
                  </h2>
                  <p>
                    Catch lost drafts and fragile error states
                    <br />
                    before your users do.
                  </p>
                  <div className="buttons">
                    <button className="primary" onClick={() => setView('create')}>
                      <Plus size={17} /> Create a Test
                    </button>
                    <button className="secondary" disabled={pending || active} onClick={runDemo}>
                      <FlaskConical size={17} /> {pending ? 'Starting…' : 'Run Demo'}{' '}
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  <small>
                    Test your own website. The optional demo shows a real failure and recovery.
                  </small>
                </div>
                <div className="diagram" aria-hidden="true">
                  <div className="node">YOUR APP</div>
                  <div className="wire">
                    <span />×<span />
                  </div>
                  <div className="node network">
                    <WifiOff size={27} /> NETWORK
                  </div>
                  <div className="signal">
                    Connection lost.
                    <br />
                    <strong>Draft preserved?</strong>
                  </div>
                </div>
              </section>
              <div className="stats">
                {stats.map(([k, v]) => (
                  <article key={k}>
                    <span>{k}</span>
                    <strong>{v}</strong>
                    <Activity size={18} />
                  </article>
                ))}
              </div>
              <section className="panel">
                <div className="panel-head">
                  <h2>
                    Recent resilience tests <span className="count">{runs.length}</span>
                  </h2>
                  <div className="panel-head-actions">
                    <span>Browser-local time · JSON reports use ISO timestamps</span>
                    <button className="secondary compact-button" onClick={() => setView('history')}>
                      <FileText size={14} /> All reports
                    </button>
                  </div>
                </div>
                {!runs.length ? (
                  <div className="empty">
                    <span className="empty-icon">
                      <FlaskConical size={29} />
                    </span>
                    <h3>Your first discovery starts here.</h3>
                    <p>
                      Run the demo or create a test for a site you own.
                      <br />
                      Every result comes from a real Chromium session.
                    </p>
                    <button className="secondary" onClick={() => setView('create')}>
                      Run Your First Test <ChevronRight size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Scenario</th>
                          <th>Result</th>
                          <th>Assertions</th>
                          <th>Duration</th>
                          <th>Started</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <button
                                className="runlink"
                                onClick={() => {
                                  setSelected(r);
                                  setView('result');
                                }}
                              >
                                {r.name}
                                <ChevronRight size={14} />
                              </button>
                              <small>{r.type}</small>
                            </td>
                            <td>
                              <span className={'badge ' + r.status}>{r.status}</span>
                            </td>
                            <td>
                              {r.passed} / {r.assertions}
                            </td>
                            <td>{(r.duration / 1000).toFixed(1)}s</td>
                            <td>{formatRunTimestamp(r.started)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <div className="guide">
                <span>
                  01 <strong>Choose a target</strong>
                  <small>A local app or a site you own.</small>
                </span>
                <span>
                  02 <strong>Disrupt the network</strong>
                  <small>Offline, failed API or delayed response.</small>
                </span>
                <span>
                  03 <strong>Inspect the evidence</strong>
                  <small>Assertions, steps and portable reports.</small>
                </span>
              </div>
            </>
          )}
          {view === 'create' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">SCENARIO BUILDER</div>
                  <h1>Make failure intentional.</h1>
                  <p>Define what should survive a connection problem.</p>
                </div>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(async () => {
                    const parsed = scenarioSchema.parse(scenario);
                    const r = await api<Run>('/api/runs', parsed);
                    setSelected(r);
                    setView('result');
                  });
                }}
              >
                <section className="panel form">
                  <h2>Test configuration</h2>
                  {notice && <p role="status">{notice}</p>}
                  <div className="buttons">
                    <button type="button" className="secondary" onClick={saveScenario}>
                      Save scenario
                    </button>
                  </div>
                  {savedScenarios.length > 0 && (
                    <SelectField
                      label="Saved scenarios"
                      value={savedScenarioName}
                      placeholder="Choose a saved scenario"
                      options={savedScenarios.map((saved) => ({ value: saved.name, label: saved.name }))}
                      onChange={(name) => {
                        const saved = savedScenarios.find((scenarioOption) => scenarioOption.name === name);
                        if (saved) {
                          setScenario(saved);
                          setSavedScenarioName(name);
                          setNotice('Saved scenario loaded.');
                        }
                      }}
                    />
                  )}
                  <p className="hint">
                    Saved scenarios stay on this computer and may contain your test inputs. With
                    custom steps, add Offline, Fail API or Delay API explicitly where the disruption
                    should happen.
                  </p>
                  <div className="columns">
                    <label>
                      Scenario name
                      <input
                        required
                        value={scenario.name}
                        maxLength={100}
                        onChange={(e) => setScenario({ ...scenario, name: e.target.value })}
                      />
                    </label>
                    <label>
                      Website URL
                      <input
                        type="url"
                        required
                        value={scenario.url}
                        onChange={(e) => setScenario({ ...scenario, url: e.target.value })}
                      />
                    </label>
                  </div>
                  <SelectField
                    label="Test type"
                    value={scenario.type}
                    options={testTypeOptions}
                    onChange={(value) => setScenario({ ...scenario, type: value as Scenario['type'] })}
                  />
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={scenario.externalConsent}
                      onChange={(e) =>
                        setScenario({ ...scenario, externalConsent: e.target.checked })
                      }
                    />{' '}
                    I own or have permission to test this external site.
                  </label>
                  <p className="hint">
                    No steps? Quick Scan records observations only. Add Check Element or Check Field
                    Value to earn a PASS or FAIL.
                  </p>
                </section>
                <section className="panel form">
                  <div className="panel-head">
                    <h2>Scenario steps</h2>
                    <button
                      type="button"
                      className="secondary"
                      disabled={scenario.steps.length >= MAX_SCENARIO_STEPS}
                      data-tooltip={`Add up to ${MAX_SCENARIO_STEPS} steps`}
                      onClick={() =>
                        setScenario({
                          ...scenario,
                          steps: [
                            ...scenario.steps,
                            {
                              action: 'check',
                              selector: '',
                              value: '',
                              path: '/api/messages',
                              delay: 1000,
                            },
                          ],
                        })
                      }
                    >
                      <Plus size={16} /> Add step
                    </button>
                  </div>
                  <p className="hint">
                    {scenario.steps.length >= MAX_SCENARIO_STEPS
                      ? `${MAX_SCENARIO_STEPS} of ${MAX_SCENARIO_STEPS} steps. Remove a step before adding or duplicating another.`
                      : `${scenario.steps.length} of ${MAX_SCENARIO_STEPS} steps`}
                  </p>
                  {scenario.steps.length === 0 && (
                    <div className="step-empty">
                      <span className="empty-icon"><ListChecks size={24} /></span>
                      <div><strong>Choose the behavior you want to verify</strong><p>Add a browser action or an assertion. You can move, copy, and edit each step later.</p></div>
                      <button type="button" className="secondary" onClick={() => setScenario({ ...scenario, steps: [{ action: 'check', selector: '', value: '', path: '/api/messages', delay: 1000 }] })}><Plus size={15} /> Add first step</button>
                    </div>
                  )}
                  {scenario.steps.map((s, i) => (
                    <div className="stepedit" key={i}>
                      <span className="stepnum">{i + 1}</span>
                      <div className="stepfields">
                        <label className="sr-only" htmlFor={'action' + i}>
                          Step {i + 1} action
                        </label>
                        <SelectField
                          id={'action' + i}
                          value={s.action}
                          options={actionOptions}
                          className="step-action-select"
                          onChange={(value) => updateStep(i, { action: value as Step['action'] })}
                        />
                        {['click', 'fill', 'check', 'value'].includes(s.action) && (
                          <input
                            aria-label={'Step ' + (i + 1) + ' selector'}
                            placeholder="CSS selector, e.g. #note"
                            required
                            value={s.selector}
                            onChange={(e) => updateStep(i, { selector: e.target.value })}
                          />
                        )}
                        {['fill', 'value'].includes(s.action) && (
                          <input
                            aria-label={'Step ' + (i + 1) + ' value'}
                            placeholder="Expected value"
                            value={s.value}
                            onChange={(e) => updateStep(i, { value: e.target.value })}
                          />
                        )}
                        {['fail', 'delay'].includes(s.action) && (
                          <input
                            aria-label="API path"
                            placeholder="/api/messages"
                            required
                            value={s.path}
                            onChange={(e) => updateStep(i, { path: e.target.value })}
                          />
                        )}
                        {s.action === 'delay' && (
                          <NumberField
                            label="Delay milliseconds"
                            value={s.delay}
                            min={0}
                            max={15000}
                            onChange={(delay) => updateStep(i, { delay })}
                          />
                        )}
                      </div>
                      <div className="stepbuttons">
                        <button
                          type="button"
                          disabled={i === 0}
                          aria-label="Move step up"
                          onClick={() => move(i, -1)}
                        >
                          <ArrowUp size={16} />
                        </button>
                        <button
                          type="button"
                          disabled={i === scenario.steps.length - 1}
                          aria-label="Move step down"
                          onClick={() => move(i, 1)}
                        >
                          <ArrowDown size={16} />
                        </button>
                        <button
                          type="button"
                          aria-label="Duplicate step"
                          data-tooltip="Duplicate step"
                          disabled={scenario.steps.length >= MAX_SCENARIO_STEPS}
                          onClick={() =>
                            setScenario({
                              ...scenario,
                              steps: [
                                ...scenario.steps.slice(0, i + 1),
                                { ...s },
                                ...scenario.steps.slice(i + 1),
                              ],
                            })
                          }
                        >
                          <Copy size={16} />
                        </button>
                        <button
                          type="button"
                          aria-label="Remove step"
                          onClick={() =>
                            setScenario({
                              ...scenario,
                              steps: scenario.steps.filter((_, j) => j !== i),
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
                <details className="panel form">
                  <summary>Advanced · privacy, timeout and JSON</summary>
                  <NumberField
                    label="Step timeout (ms)"
                    value={scenario.timeout}
                    min={1000}
                    max={30000}
                    onChange={(value) => setScenario({ ...scenario, timeout: value })}
                  />
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={scenario.screenshots}
                      onChange={(e) => setScenario({ ...scenario, screenshots: e.target.checked })}
                    />{' '}
                    Allow screenshots (form fields are masked)
                  </label>
                  <label>
                    Additional sensitive selectors (one per line)
                    <textarea
                      value={scenario.maskSelectors.join('\n')}
                      onChange={(e) =>
                        setScenario({
                          ...scenario,
                          maskSelectors: e.target.value.split('\n').filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <label>
                    Scenario JSON
                    <textarea
                      placeholder="Paste a scenario JSON"
                      value={json}
                      onChange={(e) => setJson(e.target.value)}
                    />
                  </label>
                  <div className="buttons">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        try {
                          setScenario(scenarioSchema.parse(JSON.parse(json)));
                          setError('');
                        } catch {
                          setError('Invalid scenario JSON. Check the schema and values.');
                        }
                      }}
                    >
                      Import JSON
                    </button>
                    <button type="button" className="secondary" onClick={downloadJson}>
                      Export JSON
                    </button>
                  </div>
                </details>
                <button className="primary" disabled={pending || active}>
                  {pending ? 'Starting Chromium…' : 'Run Test'} <ChevronRight size={16} />
                </button>
              </form>
            </>
          )}
          {view === 'result' && selected && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">EXECUTION / {selected.id.slice(0, 8)}</div>
                  <h1>{selected.name}</h1>
                  <p>
                    {selected.status === 'running'
                      ? 'Chromium is executing your scenario.'
                      : 'Evidence from a real browser session.'}
                  </p>
                </div>
                <span className={'badge ' + selected.status}>{selected.status}</span>
              </div>
              <div className="resultsummary panel">
                <div>
                  <span>Duration</span>
                  <strong>{(selected.duration / 1000).toFixed(1)}s</strong>
                </div>
                <div>
                  <span>Assertions passed</span>
                  <strong>
                    {selected.passed} / {selected.assertions}
                  </strong>
                </div>
                <div>
                  <span>Requests failed / injected</span>
                  <strong>
                    {selected.network.failed} / {selected.network.injected}
                  </strong>
                </div>
              </div>
              {selected.error && <div className="alert">{selected.error}</div>}
              {selected.advice && <p className="advice">{selected.advice}</p>}
              {selected.status === 'observed' && (
                <p className="advice">
                  No assertions were configured. These observations do not establish site health.
                </p>
              )}
              <section className="panel form">
                <h2>Execution timeline</h2>
                {selected.steps.map((s, i) => (
                  <div className="timeline" key={i}>
                    <span className={'badge ' + s.status}>
                      {s.status === 'pass' ? (
                        <Check size={15} />
                      ) : s.status === 'fail' ? (
                        <X size={15} />
                      ) : (
                        <Activity size={15} />
                      )}
                    </span>
                    <div>
                      <strong>{labels[s.action]}</strong>
                      <p>{s.message}</p>
                    </div>
                    <small>{s.duration} ms</small>
                  </div>
                ))}
              </section>
              {selected.screenshots.map((s, i) => (
                <img
                  className="capture"
                  src={s}
                  key={i}
                  alt={'Masked browser capture ' + (i + 1)}
                />
              ))}
              <div className="buttons">
                {selected.status === 'running' ? (
                  <button
                    className="secondary"
                    onClick={() => {
                      setNextDemo(undefined);
                      void perform(async () => {
                        await api('/api/cancel', {});
                      });
                    }}
                  >
                    Cancel run
                  </button>
                ) : (
                  ['html', 'json'].map((f) => (
                    <a className="secondary" key={f} href={'/api/reports/' + selected.id + '/' + f}>
                      <Download size={16} /> Download {f.toUpperCase()} Report
                    </a>
                  ))
                )}
              </div>
              <p className="hint">
                Reports contain screenshots only when explicitly enabled. Treat page content as
                private.
              </p>
            </>
          )}
          {view === 'history' && (
            <HistoryPage
              runs={runs}
              networkReports={networkReports}
              onOpenRun={(run) => {
                setSelected(run);
                setView('result');
              }}
              onOpenNetwork={(report) => {
                setSelectedNetwork(report);
                setView('network');
              }}
              onRefresh={refreshHistory}
            />
          )}
          {view === 'network' && (
            <NetworkInspector
              initialReport={selectedNetwork}
              onReportChange={onNetworkReportChange}
              onRefresh={refreshHistory}
              onOpenHistory={() => setView('history')}
            />
          )}
          {view === 'settings' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">WORKSPACE PREFERENCES</div>
                  <h1>Settings</h1>
                  <p>Choose where reports live and set comfortable defaults for your next check.</p>
                </div>
                <button className="secondary" onClick={resetPreferences}>Reset defaults</button>
              </div>
              {notice && <p role="status" className="notice">{notice}</p>}
              <section className="panel form settings-section">
                <div className="panel-head"><div><h2>Report storage</h2><p className="hint">Reports stay on this computer. Changing folders copies and verifies them; the previous copies are kept.</p></div></div>
                <label>
                    Report folder path
                  <input aria-label="Report storage folder" value={storageDraft || reportDirectory} onChange={(event) => setStorageDraft(event.target.value)} spellCheck={false} />
                </label>
                {storageError && <div role="alert" className="alert">{storageError}<button aria-label="Dismiss storage error" onClick={() => setStorageError('')}><X size={15} /></button></div>}
                {storageNotice && <p role="status" className="notice">{storageNotice}</p>}
                {damagedReports > 0 && <div role="status" className="notice">{damagedReports} report file{damagedReports === 1 ? ' was' : 's were'} unreadable at startup and {damagedReports === 1 ? 'was' : 'were'} left in the folder unchanged for recovery.</div>}
                <div className="buttons settings-actions">
                  <button type="button" className="secondary" onClick={() => void browseReportFolder()} disabled={storageBusy}><FileText size={15} /> Browse…</button>
                  <button type="button" className="primary" onClick={() => void useReportFolder()} disabled={storageBusy || !storageDraft.trim() || storageDraft.trim() === reportDirectory}>{storageBusy ? 'Copying reports…' : 'Use this folder'}</button>
                  <button type="button" className="secondary" onClick={() => void openReportFolder()} disabled={!window.linksunderDesktop}><FolderOpen size={15} /> Open folder</button>
                </div>
                {!window.linksunderDesktop && <p className="hint">Folder browsing and Open folder are available in the installed desktop app. You can enter an absolute folder path here.</p>}
              </section>
              <section className="panel form settings-section">
                <h2>Default test preferences</h2>
                <div className="columns">
                  <SelectField label="Appearance" value={theme} options={appearanceOptions} onChange={setTheme} />
                  <NumberField
                    label="Default step timeout (ms)"
                    value={timeout}
                    min={1000}
                    max={30000}
                    onChange={(value) => {
                      setTimeoutValue(value);
                      localStorage.setItem('timeout', String(value));
                    }}
                  />
                </div>
                <label className="checkbox preference-checkbox"><input type="checkbox" checked={defaultScreenshots} onChange={(event) => setDefaultScreenshots(event.target.checked)} /> Start new scenarios with screenshots enabled</label>
                <p className="hint">Screenshots can contain page content. You can change this default for an individual scenario at any time.</p>
              </section>
              <section className="panel form settings-section">
                <h2>Privacy and retention</h2>
                <dl>
                  <dt>Report retention</dt><dd>Keep all reports until you delete them. There is no automatic cleanup.</dd>
                  <dt>Browser</dt><dd>Isolated headless Chromium. Service workers are blocked; saved cookies and login sessions are not used.</dd>
                  <dt>Resilience test boundaries</dt><dd>One check at a time. External targets require permission. Resilience tests block other local origins and private or metadata endpoints.</dd>
                  <dt>Network Inspector boundaries</dt><dd>One target at a time, explicit authorization, up to 20 selected TCP ports, and short HEAD requests only. It does not exploit or authenticate.</dd>
                  <dt>Data privacy</dt><dd>No telemetry. Response bodies and cookie values are not saved. Screenshot masking remains available for resilience tests.</dd>
                </dl>
              </section>
            </>
          )}
          <footer>
            <span>
              LinkSunder <span className="muted">/</span> A small lab for a stronger web.
            </span>
            <span>LOCAL FIRST. OPEN SOURCE.</span>
          </footer>
        </div>
      </main>
    </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
