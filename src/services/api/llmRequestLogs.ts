/**
 * LLM 请求日志 API（管理面板）
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

export interface LLMRequestLogEntry {
  id: string;
  time: string;
  token: string;
  group: string;
  type: string;
  model: string;
  latency_ms: number;
  ttft_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  exit_ip: string;
  exit_node: string;
  thinking_level: string;
  has_thinking: boolean;
  thinking_len: number;
  failed: boolean;
  status_code: number;
  provider: string;
  endpoint: string;
  request_id: string;
  auth_id: string;
  source: string;
  detail?: unknown;
}

export interface LLMRequestLogsResponse {
  items: LLMRequestLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface LLMRequestLogsQuery {
  limit?: number;
  offset?: number;
}

const numberValue = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');

const booleanValue = (value: unknown): boolean => value === true;

const normalizeEntry = (value: unknown): LLMRequestLogEntry | null => {
  if (!isRecord(value)) return null;
  return {
    id: stringValue(value.id),
    time: stringValue(value.time),
    token: stringValue(value.token),
    group: stringValue(value.group),
    type: stringValue(value.type),
    model: stringValue(value.model),
    latency_ms: numberValue(value.latency_ms),
    ttft_ms: numberValue(value.ttft_ms),
    prompt_tokens: numberValue(value.prompt_tokens),
    completion_tokens: numberValue(value.completion_tokens),
    cost: numberValue(value.cost),
    exit_ip: stringValue(value.exit_ip),
    exit_node: stringValue(value.exit_node),
    thinking_level: stringValue(value.thinking_level),
    has_thinking: booleanValue(value.has_thinking),
    thinking_len: numberValue(value.thinking_len),
    failed: booleanValue(value.failed),
    status_code: numberValue(value.status_code),
    provider: stringValue(value.provider),
    endpoint: stringValue(value.endpoint),
    request_id: stringValue(value.request_id),
    auth_id: stringValue(value.auth_id),
    source: stringValue(value.source),
    detail: value.detail,
  };
};

const normalizeResponse = (data: unknown): LLMRequestLogsResponse => {
  if (!isRecord(data)) {
    return { items: [], total: 0, limit: 0, offset: 0 };
  }
  const items = Array.isArray(data.items)
    ? data.items.map(normalizeEntry).filter((item): item is LLMRequestLogEntry => item !== null)
    : [];
  return {
    items,
    total: numberValue(data.total),
    limit: numberValue(data.limit),
    offset: numberValue(data.offset),
  };
};

export const llmRequestLogsApi = {
  async fetchLogs(params: LLMRequestLogsQuery = {}): Promise<LLMRequestLogsResponse> {
    const data = await apiClient.get('/llm-request-logs', { params });
    return normalizeResponse(data);
  },

  async clearLogs(): Promise<{ ok: boolean; cleared: number }> {
    const data = await apiClient.delete('/llm-request-logs');
    if (!isRecord(data)) {
      return { ok: false, cleared: 0 };
    }
    return {
      ok: data.ok === true || data.ok === undefined,
      cleared: numberValue(data.cleared),
    };
  },
};
