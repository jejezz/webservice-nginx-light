export const AGENT_VERSION: string;

export type CheckState = 'ok' | 'warn' | 'error';
export interface Check {
  id: string;
  state: CheckState;
  msg?: string;
}
export interface AgentConfig {
  serverUrl: string;
  siteId: string;
  siteSecret: string;
}
export interface Store {
  load(): Promise<AgentConfig | null>;
  save(config: AgentConfig): Promise<void>;
}
export interface SendOutcome {
  ok: boolean;
  /** 서버 HTTP 상태. 네트워크 오류는 0 */
  http: number;
  retryable: boolean;
  result: 'ok' | 'throttled_or_server_error' | 'rejected' | 'network';
  /** 마지막 전송 결과(`agent.last`)에만 있다 */
  at?: string;
}
export type AgentErrorCode =
  | 'invalid_code'
  | 'rate_limited'
  | 'network'
  | 'server_error'
  | 'invalid_response'
  | 'not_configured'
  | 'invalid_config';

export class AgentError extends Error {
  code: AgentErrorCode;
  http?: number;
}

export function fileStore(path: string): Store;
export function parseEnrollCode(code: string): { siteId: string; serverUrl: string } | null;
export function sign(siteSecret: string, timestamp: string, bodyBytes: Uint8Array): string;
export function reportOffsetMs(siteId: string): number;
export function nextReportAt(siteId: string, nowMs: number, jitter?: number): number;
export function certCheck(daysLeft: number, thresholds?: { warnDays?: number; errorDays?: number }): Check;
export function normalizeChecks(raw: unknown): { checks: Check[]; overall: CheckState };
export function collectMetrics(): Promise<{ cpu?: number; ram?: number; disk?: number; uptimeSec: number }>;

export interface CentralAgentOptions {
  store: Store;
  collectChecks?: () => Promise<Check[]>;
  /** 인증서 중 가장 짧은 남은 일수. 주면 `cert` 점검 항목도 자동으로 만든다 */
  getCertMinDays?: () => Promise<number | undefined>;
  /** 이 일수 이하면 warn (기본 14) */
  certWarnDays?: number;
  /** 이 일수 이하면 error (기본 5) */
  certErrorDays?: number;
  versions?: { manager?: string };
  log?: (level: string, msg: string) => void;
  /** 로컬 시험에서만 true. 기본은 HTTPS 만 허용 */
  allowHttp?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export class CentralAgent {
  constructor(options: CentralAgentOptions);
  last: SendOutcome | null;
  /** 정기 보고가 돌고 있는지 */
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  sending: Promise<unknown> | null;
  isEnrolled(): Promise<boolean>;
  enroll(code: string): Promise<SendOutcome>;
  buildPayload(config: AgentConfig): Promise<Record<string, unknown>>;
  sendOnce(payload?: Record<string, unknown>): Promise<SendOutcome>;
  sendWithRetry(sleep?: (ms: number) => Promise<void>, shouldStop?: () => boolean): Promise<SendOutcome>;
  /** 등록돼 있으면 보고를 시작한다. 등록 전(설정이 비어 있음)이면 아무것도 보내지 않고 기다리며, 이후 enroll() 이 성공하면 시작한다 */
  start(): Promise<void>;
  stop(): void;
}
