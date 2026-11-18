import { z } from 'zod';
import type { StepResult } from './schema.js';

export const apiMethods = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const apiTestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url().max(2000),
  externalConsent: z.boolean().default(false),
  method: z.enum(apiMethods).default('GET'),
  query: z.array(z.object({ name: z.string().max(200), value: z.string().max(2000) })).max(50).default([]),
  headers: z.array(z.object({ name: z.string().trim().min(1).max(200), value: z.string().max(4000) })).max(50).default([]),
  body: z.string().max(65536).default(''),
  timeout: z.number().int().min(500).max(30000).default(10000),
  redirectPolicy: z.enum(['manual', 'same-origin']).default('manual'),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  expectedTimeMs: z.number().int().min(1).max(30000).optional(),
  expectedHeaders: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  jsonAssertions: z.array(z.object({
    path: z.string().trim().min(1).max(300),
    operator: z.enum(['exists', 'equals']),
    expected: z.string().max(2000).default(''),
  })).max(30).default([]),
  jsonSchema: z.string().max(12000).default(''),
  retries: z.number().int().min(0).max(2).default(0),
  fault: z.enum(['none', 'http-503', 'latency', 'interrupt', 'timeout']).default('none'),
  faultDelayMs: z.number().int().min(1).max(15000).default(1000),
  confirmUnsafe: z.boolean().default(false),
}).superRefine((value, context) => {
  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method);
  if (unsafe && !value.confirmUnsafe)
    context.addIssue({ code: 'custom', path: ['confirmUnsafe'], message: 'Confirm before sending a request that can change data.' });
  if (unsafe && value.retries > 0)
    context.addIssue({ code: 'custom', path: ['retries'], message: 'Automatic retries are limited to GET, HEAD and OPTIONS.' });
  if (unsafe && value.fault !== 'none')
    context.addIssue({ code: 'custom', path: ['fault'], message: 'Fault simulations that repeat a request are limited to GET, HEAD and OPTIONS.' });
  if (!['POST', 'PUT', 'PATCH'].includes(value.method) && value.body.trim())
    context.addIssue({ code: 'custom', path: ['body'], message: 'A request body is only available for POST, PUT and PATCH.' });
});

export type ApiTestConfig = z.infer<typeof apiTestSchema>;
export interface ApiTestSample {
  statusCode?: number;
  originalStatusCode?: number;
  responseTimeMs?: number;
  contentType?: string;
  httpVersion?: string;
  responseHeaders: Record<string, string>;
  redirectChain: string[];
  failureReason?: string;
  preview?: string;
}
export interface ApiTestEvidence {
  method: string;
  target: string;
  requestCount: number;
  fault: ApiTestConfig['fault'];
  faultTriggered: boolean;
  faultNote?: string;
  baseline?: ApiTestSample;
  disrupted?: ApiTestSample;
  recovery?: ApiTestSample;
  limitations: string[];
}
export type ApiTestRun = import('./schema.js').Run & { apiTest?: ApiTestEvidence; steps: StepResult[] };
