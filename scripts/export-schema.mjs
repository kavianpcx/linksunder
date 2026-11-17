import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJSONSchema } from 'zod';
import { scenarioSchema } from '../shared/schema.ts';

const document = {
  ...toJSONSchema(scenarioSchema),
  $id: 'https://github.com/kavianpcx/linksunder/schema/scenario/v1',
  title: 'LinkSunder scenario',
  description: 'A LinkSunder network resilience test scenario.',
  'x-linksunder-schema-version': 1,
};

await writeFile(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'scenario.schema.json'),
  JSON.stringify(document, null, 2) + '\n',
);
