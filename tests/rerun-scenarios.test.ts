import { describe, expect, it } from 'vitest';
import { scenarioSchema } from '../shared/schema';
import {
  clearRunScenarios,
  changeScenarioType,
  getRerunScenario,
  getRerunnableScenarioIds,
  rememberRunScenario,
  removeRunScenarios,
  RERUN_SCENARIOS_KEY,
} from '../client/rerun-scenarios';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const scenario = scenarioSchema.parse({
  name: 'Offline draft recovery',
  url: 'https://example.test/editor?workspace=local',
  type: 'offline',
  externalConsent: true,
  steps: [
    { action: 'click', selector: 'Save', locator: 'button' },
    { action: 'offline' },
    { action: 'check', selector: 'Retry', locator: 'text' },
    { action: 'online' },
  ],
});

describe('local report rerun scenarios', () => {
  it('stores a private validated copy and requires authorization again', () => {
    const storage = new MemoryStorage();
    const id = '00000000-0000-4000-8000-000000000001';

    expect(rememberRunScenario(id, scenario, storage)).toBe(true);
    expect(getRerunScenario(id, storage)).toEqual({ ...scenario, externalConsent: false });
    expect(getRerunnableScenarioIds(storage)).toEqual([id]);
    expect(storage.getItem(RERUN_SCENARIOS_KEY)).toContain('workspace=local');
  });

  it('changes the disruption step with the selected test type', () => {
    const changed = changeScenarioType(scenario, 'slow');
    expect(changed.type).toBe('slow');
    expect(changed.steps.map((step) => step.action)).toEqual(['click', 'delay', 'check', 'online']);
    expect(changeScenarioType(changed, 'health').steps).toEqual([]);
  });

  it('removes saved inputs when reports are deleted or history is cleared', () => {
    const storage = new MemoryStorage();
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    rememberRunScenario(first, scenario, storage);
    rememberRunScenario(second, scenario, storage);

    removeRunScenarios([first], storage);
    expect(getRerunnableScenarioIds(storage)).toEqual([second]);
    clearRunScenarios(storage);
    expect(storage.getItem(RERUN_SCENARIOS_KEY)).toBeNull();
  });

  it('rejects malformed IDs and invalid scenario input', () => {
    const storage = new MemoryStorage();
    expect(rememberRunScenario('../report', scenario, storage)).toBe(false);
    expect(rememberRunScenario('00000000-0000-4000-8000-000000000001', { name: '' }, storage)).toBe(false);
    expect(getRerunnableScenarioIds(storage)).toEqual([]);
  });
});
