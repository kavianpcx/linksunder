import { scenarioSchema, type Scenario } from '../shared/schema';

export const RERUN_SCENARIOS_KEY = 'linksunder:rerun-scenarios';

const MAX_SCENARIOS = 40;
const MAX_STORAGE_CHARACTERS = 1_200_000;

interface SavedScenario {
  savedAt: number;
  scenario: Scenario;
}

type ScenarioStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storedScenarios(storage: ScenarioStorage): Record<string, SavedScenario> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RERUN_SCENARIOS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, entry]) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as Partial<SavedScenario>;
      const scenario = scenarioSchema.safeParse(candidate.scenario);
      if (!Number.isFinite(candidate.savedAt) || !scenario.success) return [];
      return [[id, {
        savedAt: candidate.savedAt!,
        scenario: { ...scenario.data, externalConsent: false },
      }]];
    }));
  } catch {
    return {};
  }
}

export function getRerunScenario(id: string, storage: ScenarioStorage = localStorage): Scenario | undefined {
  return storedScenarios(storage)[id]?.scenario;
}

export function getRerunnableScenarioIds(storage: ScenarioStorage = localStorage): string[] {
  return Object.keys(storedScenarios(storage));
}

export function rememberRunScenario(id: string, value: unknown, storage: ScenarioStorage = localStorage): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const scenario = scenarioSchema.safeParse(value);
  if (!scenario.success) return false;
  const entries = storedScenarios(storage);
  delete entries[id];
  entries[id] = {
    savedAt: Date.now(),
    scenario: { ...scenario.data, externalConsent: false },
  };
  const newestFirst = Object.entries(entries).sort((left, right) => right[1].savedAt - left[1].savedAt);
  const retained: Record<string, SavedScenario> = {};
  for (const [entryId, entry] of newestFirst.slice(0, MAX_SCENARIOS)) retained[entryId] = entry;
  while (JSON.stringify(retained).length > MAX_STORAGE_CHARACTERS) {
    const oldest = Object.keys(retained).at(-1);
    if (!oldest || oldest === id) return false;
    delete retained[oldest];
  }
  try {
    storage.setItem(RERUN_SCENARIOS_KEY, JSON.stringify(retained));
    return Object.hasOwn(retained, id);
  } catch {
    return false;
  }
}

export function removeRunScenarios(ids: string[], storage: ScenarioStorage = localStorage): void {
  const entries = storedScenarios(storage);
  for (const id of ids) delete entries[id];
  try {
    if (Object.keys(entries).length) storage.setItem(RERUN_SCENARIOS_KEY, JSON.stringify(entries));
    else storage.removeItem(RERUN_SCENARIOS_KEY);
  } catch {
    // Keeping an old local draft is harmless if storage is unavailable.
  }
}

export function clearRunScenarios(storage: ScenarioStorage = localStorage): void {
  try {
    storage.removeItem(RERUN_SCENARIOS_KEY);
  } catch {
    // History deletion should still complete if local storage is unavailable.
  }
}

const faultAction: Record<Exclude<Scenario['type'], 'health'>, Scenario['steps'][number]['action']> = {
  offline: 'offline',
  failure: 'fail',
  slow: 'delay',
};

export function changeScenarioType(scenario: Scenario, type: Scenario['type']): Scenario {
  if (type === 'health') return { ...scenario, type, steps: [] };
  if (scenario.type === 'health') return { ...scenario, type };

  const previousFault = faultAction[scenario.type];
  const nextFault = faultAction[type];
  const matchingSteps = scenario.steps.flatMap((step, index) => step.action === previousFault ? [index] : []);
  const steps = matchingSteps.length === 1
    ? scenario.steps.map((step, index) => index === matchingSteps[0]
      ? { ...step, action: nextFault, delay: type === 'slow' && step.delay < 1 ? 1000 : step.delay }
      : step)
    : scenario.steps;
  return { ...scenario, type, steps };
}
