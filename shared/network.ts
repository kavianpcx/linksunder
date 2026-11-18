import { z } from 'zod';

export const COMMON_PORTS = [
  80, 443, 22, 21, 25, 53, 110, 143, 3306, 5432, 6379, 27017, 8080, 8443,
] as const;
export const MAX_NETWORK_PORTS = 20;
export const MAX_NETWORK_TIMEOUT_MS = 3000;
export const MAX_DNS_TIMEOUT_MS = 10000;

export const networkInspectionSchema = z.object({
  target: z.string().trim().min(1).max(500),
  ports: z
    .array(z.number().int().min(1).max(65535))
    .min(1)
    .max(MAX_NETWORK_PORTS)
    .refine((ports) => new Set(ports).size === ports.length, 'Port numbers must be unique.'),
  timeout: z.number().int().min(500).max(MAX_NETWORK_TIMEOUT_MS).default(1200),
  dnsTimeout: z.number().int().min(500).max(MAX_DNS_TIMEOUT_MS).default(2500),
  dnsRetries: z.number().int().min(0).max(2).default(1),
  authorized: z.literal(true),
});

export type NetworkInspectionRequest = z.infer<typeof networkInspectionSchema>;
export type NetworkPortStatus = 'OPEN' | 'CLOSED' | 'UNKNOWN' | 'ERROR';
export type DnsResultStatus = 'found' | 'no-record' | 'NXDOMAIN' | 'timeout' | 'resolver-failure' | 'unsupported' | 'not-applicable' | 'cancelled';
export interface DnsRecordDiagnostic {
  status: DnsResultStatus;
  durationMs: number;
  attempts: number;
  error?: string;
}
export type NetworkReportStatus = 'running' | 'complete' | 'cancelled' | 'error';
export type FindingSeverity = 'Info' | 'Low' | 'Medium' | 'High';

export interface PortResult {
  port: number;
  protocol: 'TCP';
  status: NetworkPortStatus;
  durationMs?: number;
  note?: string;
}

export interface DnsSummary {
  A: string[];
  AAAA: string[];
  CNAME: string[];
  NS: string[];
  MX: Array<{ exchange: string; priority: number }>;
  TXT?: string[];
  SOA?: { nsname: string; hostmaster: string; serial: number; refresh: number; retry: number; expire: number; minttl: number };
  records?: Partial<Record<'A' | 'AAAA' | 'CNAME' | 'NS' | 'MX' | 'TXT' | 'SOA', DnsRecordDiagnostic>>;
  resolvedAddresses?: Array<{ address: string; family: number }>;
  systemResolution?: DnsRecordDiagnostic;
  inputAddress?: string;
  reverse: Array<{ address: string; names: string[] }>;
  reverseDiagnostics?: Array<{ address: string; result: DnsRecordDiagnostic }>;
  lookupTimeMs: number;
  note?: string;
}

export interface HttpCheck {
  scheme: 'http' | 'https';
  method?: 'HEAD' | 'GET';
  httpVersion?: string;
  status?: number;
  finalUrl?: string;
  redirectChain: string[];
  responseTimeMs?: number;
  contentType?: string;
  server?: string;
  contentEncoding?: string;
  redirectsToHttps?: boolean;
  securityHeaders: Record<string, { present: boolean; summary?: string }>;
  cookieFlags: Array<{ secure: boolean; httpOnly: boolean; sameSite?: string }>;
  error?: string;
  errorCode?: string;
}

export interface TlsSummary {
  port: number;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  daysUntilExpiry?: number;
  subjectAltNames: string[];
  fingerprint256?: string;
  protocol?: string;
  selfSigned?: boolean;
  hostnameMismatch?: boolean;
  authorized?: boolean;
  error?: string;
}

export interface GeolocationRecord {
  ip: string;
  status: 'found' | 'private' | 'not-found' | 'unavailable';
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  accuracyRadiusKm?: number;
  timeZone?: string;
  asn?: number;
  organization?: string;
  source?: string;
  cityDatabaseDate?: string;
  asnDatabaseDate?: string;
}

export interface GeolocationDatabaseInfo {
  kind: 'city' | 'asn';
  configured: boolean;
  path?: string;
  databaseType?: string;
  updatedAt?: string;
}

export interface NetworkFinding {
  severity: FindingSeverity;
  title: string;
  detail: string;
}

export interface NetworkReport {
  id: string;
  kind: 'network';
  target: string;
  hostname: string;
  started: string;
  completed?: string;
  status: NetworkReportStatus;
  progress: string;
  dns: DnsSummary;
  ports: PortResult[];
  http: HttpCheck[];
  tls?: TlsSummary;
  geolocation?: GeolocationRecord[];
  findings: NetworkFinding[];
  limitations: string[];
  error?: string;
}
