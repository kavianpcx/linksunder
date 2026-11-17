import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toJSONSchema } from 'zod';
import { demoScenario, scenarioSchema } from '../shared/schema';

const generated = JSON.parse(
  readFileSync(new URL('../docs/scenario.schema.json', import.meta.url), 'utf8'),
);

describe('scenario JSON Schema', () => {
  it('matches the shared schema and includes version metadata', () => {
    const { $id, title, description, 'x-linksunder-schema-version': version, ...schema } =
      generated;
    expect({ $id, title, description, version }).toEqual({
      $id: 'https://github.com/kavianpcx/linksunder/schema/scenario/v1',
      title: 'LinkSunder scenario',
      description: 'A LinkSunder network resilience test scenario.',
      version: 1,
    });
    expect(schema).toEqual(toJSONSchema(scenarioSchema));
  });

  it('covers valid demos, invalid actions and privacy defaults', () => {
    expect(scenarioSchema.safeParse(demoScenario('http://localhost', 'fixed')).success).toBe(true);
    expect(
      scenarioSchema.safeParse({
        name: 'Invalid',
        url: 'http://localhost',
        steps: [{ action: 'not-an-action' }],
      }).success,
    ).toBe(false);
    expect(generated.properties.externalConsent.default).toBe(false);
    expect(generated.properties.screenshots.default).toBe(false);
    expect(generated.properties.steps.items.properties.action.enum).toHaveLength(10);
  });
});
