import { z } from 'zod';
export const actions = [
  'open',
  'click',
  'fill',
  'offline',
  'online',
  'fail',
  'delay',
  'check',
  'value',
  'screenshot',
] as const;
export const MAX_SCENARIO_STEPS = 50;
export const stepSchema = z.object({
  action: z.enum(actions),
  selector: z.string().max(500).default(''),
  value: z.string().max(2000).default(''),
  path: z.string().max(300).default('/api/messages'),
  delay: z.number().int().min(0).max(15000).default(1000),
});
export const scenarioSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url().max(2000),
  type: z.enum(['offline', 'failure', 'slow']).default('offline'),
  externalConsent: z.boolean().default(false),
  timeout: z.number().int().min(1000).max(30000).default(10000),
  screenshots: z.boolean().default(false),
  maskSelectors: z.array(z.string().min(1).max(500)).max(20).default([]),
  steps: z.array(stepSchema).max(MAX_SCENARIO_STEPS).default([]),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Status = 'running' | 'pass' | 'fail' | 'observed' | 'error' | 'cancelled';
export interface StepResult {
  action: string;
  status: 'running' | 'pass' | 'fail';
  message: string;
  duration: number;
}
export interface Run {
  id: string;
  name: string;
  targetHost?: string;
  type: string;
  status: Status;
  started: string;
  duration: number;
  steps: StepResult[];
  assertions: number;
  passed: number;
  error?: string;
  advice?: string;
  screenshots: string[];
  network: { failed: number; injected: number };
}
export function demoScenario(base: string, mode: 'broken' | 'fixed'): Scenario {
  return scenarioSchema.parse({
    name: `${mode === 'broken' ? 'Broken' : 'Fixed'} · draft preservation`,
    url: `${base}/demo/${mode}`,
    screenshots: true,
    steps: [
      { action: 'fill', selector: '#note', value: 'Keep my draft safe.' },
      { action: 'offline' },
      { action: 'click', selector: '#send' },
      { action: 'check', selector: '#status[data-state="error"]' },
      { action: 'value', selector: '#note', value: 'Keep my draft safe.' },
      { action: 'online' },
      { action: 'value', selector: '#note', value: 'Keep my draft safe.' },
      { action: 'screenshot' },
    ],
  });
}
