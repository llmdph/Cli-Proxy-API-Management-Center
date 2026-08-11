/**
 * grok-inspection 插件管理 API
 * 路径前缀：/plugins/grok-inspection（相对 /v0/management）
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

const BASE = '/plugins/grok-inspection';

export type GrokClassification =
  | 'healthy'
  | 'permission_denied'
  | 'quota_exhausted'
  | 'spending_limit'
  | 'reauth'
  | 'no_think_stream'
  | 'model_unavailable'
  | 'probe_error'
  | 'unknown'
  | 'other'
  | string;

export interface GrokAccountResult {
  auth_index: string;
  name: string;
  file_name?: string;
  email?: string;
  disabled: boolean;
  classification: GrokClassification;
  action: string;
  reason: string;
  http_status?: number;
  model?: string;
  error_code?: string;
  error_message?: string;
}

export interface GrokRowActionReport {
  seq: number;
  key?: string;
  action?: string;
  ok: boolean;
  error?: string;
}

export interface GrokInspectionSchedule {
  enabled: boolean;
  interval_minutes: number;
  workers: number;
  include_disabled: boolean;
  only_disabled?: boolean;
  scope?: string;
  sample_count?: number;
  sample_percent?: number;
  permission_denied_action: string;
  spending_limit_action: string;
  auto_recover_healthy?: boolean;
  last_run_at?: string;
  next_run_at?: string;
  last_status?: string;
  last_error?: string;
}

export interface GrokInspectionStatus {
  running: boolean;
  stopped: boolean;
  applying: boolean;
  incremental: boolean;
  sample: boolean;
  sample_count?: number;
  sample_percent?: number;
  classifications?: string[];
  done: number;
  total: number;
  workers: number;
  probe_phase?: string;
  retry_done: number;
  retry_total: number;
  retry_workers: number;
  include_disabled: boolean;
  only_disabled: boolean;
  apply_done: number;
  apply_total: number;
  apply_current?: string;
  apply_failures?: string[];
  action_in_flight: number;
  recent_row_actions?: GrokRowActionReport[];
  started_at?: string;
  finished_at?: string;
  results?: GrokAccountResult[];
  summary: Record<string, number>;
  store_path?: string;
  results_gen: number;
  include_results: boolean;
  persist_error?: string;
  schedule: GrokInspectionSchedule;
  unban?: Record<string, unknown>;
}

export interface GrokStartOptions {
  lang?: string;
  workers: number;
  include_disabled: boolean;
  only_disabled: boolean;
  incremental?: boolean;
  sample?: boolean;
  sample_count?: number;
  sample_percent?: number;
  classifications?: string[];
  auth_indexes?: string[];
}

export interface GrokBanEntry {
  auth_id: string;
  provider?: string;
  error_code?: string;
  category?: string;
  banned_at?: string;
  reset_at?: string;
  reset_source?: string;
  remaining_seconds?: number;
  cpa_synced?: boolean;
  cpa_sync_error?: string;
}

export interface GrokBansResponse {
  bans: GrokBanEntry[];
  count?: number;
  enabled?: boolean;
  fallback_hours?: number;
  unsynced_count?: number;
  quota_count?: number;
  spending_limit_count?: number;
  permission_count?: number;
  unauthorized_count?: number;
  manual_disabled_count?: number;
  [key: string]: unknown;
}

const numberValue = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const booleanValue = (value: unknown): boolean => value === true;

const normalizeResult = (value: unknown): GrokAccountResult | null => {
  if (!isRecord(value)) return null;
  return {
    auth_index: stringValue(value.auth_index),
    name: stringValue(value.name),
    file_name: stringValue(value.file_name) || undefined,
    email: stringValue(value.email) || undefined,
    disabled: booleanValue(value.disabled),
    classification: stringValue(value.classification) || 'unknown',
    action: stringValue(value.action),
    reason: stringValue(value.reason),
    http_status: numberValue(value.http_status) || undefined,
    model: stringValue(value.model) || undefined,
    error_code: stringValue(value.error_code) || undefined,
    error_message: stringValue(value.error_message) || undefined,
  };
};

const normalizeSchedule = (value: unknown): GrokInspectionSchedule => {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: booleanValue(raw.enabled),
    interval_minutes: numberValue(raw.interval_minutes, 60),
    workers: numberValue(raw.workers, 6),
    include_disabled: booleanValue(raw.include_disabled),
    only_disabled: booleanValue(raw.only_disabled),
    scope: stringValue(raw.scope) || 'full',
    sample_count: numberValue(raw.sample_count) || undefined,
    sample_percent: numberValue(raw.sample_percent) || undefined,
    permission_denied_action: stringValue(raw.permission_denied_action) || 'disable',
    spending_limit_action: stringValue(raw.spending_limit_action) || 'disable',
    auto_recover_healthy: booleanValue(raw.auto_recover_healthy),
    last_run_at: stringValue(raw.last_run_at) || undefined,
    next_run_at: stringValue(raw.next_run_at) || undefined,
    last_status: stringValue(raw.last_status) || undefined,
    last_error: stringValue(raw.last_error) || undefined,
  };
};

export const normalizeStatus = (value: unknown): GrokInspectionStatus => {
  const raw = isRecord(value) ? value : {};
  const results = Array.isArray(raw.results)
    ? raw.results.map(normalizeResult).filter((item): item is GrokAccountResult => Boolean(item))
    : undefined;
  const summary = isRecord(raw.summary)
    ? Object.fromEntries(
        Object.entries(raw.summary).map(([key, entry]) => [key, numberValue(entry)])
      )
    : {};
  const recent = Array.isArray(raw.recent_row_actions)
    ? raw.recent_row_actions
        .filter(isRecord)
        .map((entry) => ({
          seq: numberValue(entry.seq),
          key: stringValue(entry.key) || undefined,
          action: stringValue(entry.action) || undefined,
          ok: booleanValue(entry.ok),
          error: stringValue(entry.error) || undefined,
        }))
    : undefined;

  return {
    running: booleanValue(raw.running),
    stopped: booleanValue(raw.stopped),
    applying: booleanValue(raw.applying),
    incremental: booleanValue(raw.incremental),
    sample: booleanValue(raw.sample),
    sample_count: numberValue(raw.sample_count) || undefined,
    sample_percent: numberValue(raw.sample_percent) || undefined,
    classifications: Array.isArray(raw.classifications)
      ? raw.classifications.map(stringValue).filter(Boolean)
      : undefined,
    done: numberValue(raw.done),
    total: numberValue(raw.total),
    workers: numberValue(raw.workers, 6),
    probe_phase: stringValue(raw.probe_phase) || undefined,
    retry_done: numberValue(raw.retry_done),
    retry_total: numberValue(raw.retry_total),
    retry_workers: numberValue(raw.retry_workers),
    include_disabled: booleanValue(raw.include_disabled),
    only_disabled: booleanValue(raw.only_disabled),
    apply_done: numberValue(raw.apply_done),
    apply_total: numberValue(raw.apply_total),
    apply_current: stringValue(raw.apply_current) || undefined,
    apply_failures: Array.isArray(raw.apply_failures)
      ? raw.apply_failures.map(stringValue).filter(Boolean)
      : undefined,
    action_in_flight: numberValue(raw.action_in_flight),
    recent_row_actions: recent,
    started_at: stringValue(raw.started_at) || undefined,
    finished_at: stringValue(raw.finished_at) || undefined,
    results,
    summary,
    store_path: stringValue(raw.store_path) || undefined,
    results_gen: numberValue(raw.results_gen),
    include_results: booleanValue(raw.include_results),
    persist_error: stringValue(raw.persist_error) || undefined,
    schedule: normalizeSchedule(raw.schedule),
    unban: isRecord(raw.unban) ? raw.unban : undefined,
  };
};

const unwrapPayload = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  if (isRecord(value.result)) return value.result;
  return value;
};

export const grokInspectionApi = {
  async status(options?: { includeResults?: boolean; lang?: string }): Promise<GrokInspectionStatus> {
    const params = new URLSearchParams();
    if (options?.includeResults === false) params.set('include_results', '0');
    if (options?.lang) params.set('lang', options.lang);
    const query = params.toString();
    const data = await apiClient.get(`${BASE}/status${query ? `?${query}` : ''}`);
    return normalizeStatus(unwrapPayload(data));
  },

  async start(body: GrokStartOptions): Promise<unknown> {
    return apiClient.post(`${BASE}/start`, body);
  },

  async stop(lang?: string): Promise<unknown> {
    return apiClient.post(`${BASE}/stop`, { lang: lang || 'zh' });
  },

  async apply(body: {
    lang?: string;
    auth_indexes?: string[];
    actions?: string[];
    classifications?: string[];
    force_action?: string;
  }): Promise<unknown> {
    return apiClient.post(`${BASE}/apply`, body);
  },

  async action(body: {
    lang?: string;
    auth_index: string;
    name: string;
    disabled?: boolean;
    delete?: boolean;
    refresh?: boolean;
  }): Promise<{ ok?: boolean; action_seq?: number; error?: string }> {
    const data = await apiClient.post(`${BASE}/action`, body);
    const payload = unwrapPayload(data);
    if (!isRecord(payload)) return {};
    return {
      ok: payload.ok !== false,
      action_seq: numberValue(payload.action_seq) || undefined,
      error: stringValue(payload.error) || undefined,
    };
  },

  async schedule(): Promise<GrokInspectionSchedule> {
    const data = await apiClient.get(`${BASE}/schedule`);
    return normalizeSchedule(unwrapPayload(data));
  },

  async updateSchedule(body: Partial<GrokInspectionSchedule>): Promise<GrokInspectionSchedule> {
    const data = await apiClient.post(`${BASE}/schedule`, body);
    return normalizeSchedule(unwrapPayload(data));
  },

  async bans(): Promise<GrokBansResponse> {
    const data = await apiClient.get(`${BASE}/bans`);
    const payload = unwrapPayload(data);
    const raw = isRecord(payload) ? payload : {};
    const list = Array.isArray(raw.bans)
      ? raw.bans
      : Array.isArray(raw.items)
        ? raw.items
        : [];
    return {
      ...raw,
      bans: list.filter(isRecord).map((entry) => ({
        auth_id: stringValue(entry.auth_id),
        provider: stringValue(entry.provider) || undefined,
        error_code: stringValue(entry.error_code) || undefined,
        category: stringValue(entry.category) || undefined,
        banned_at: stringValue(entry.banned_at) || undefined,
        reset_at: stringValue(entry.reset_at) || undefined,
        reset_source: stringValue(entry.reset_source) || undefined,
        remaining_seconds: numberValue(entry.remaining_seconds) || undefined,
        cpa_synced: typeof entry.cpa_synced === 'boolean' ? entry.cpa_synced : undefined,
        cpa_sync_error: stringValue(entry.cpa_sync_error) || undefined,
      })),
      count: numberValue(raw.count, list.length),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
      fallback_hours: numberValue(raw.fallback_hours) || undefined,
      unsynced_count: numberValue(raw.unsynced_count),
      quota_count: numberValue(raw.quota_count),
      spending_limit_count: numberValue(raw.spending_limit_count),
      permission_count: numberValue(raw.permission_count),
      unauthorized_count: numberValue(raw.unauthorized_count),
      manual_disabled_count: numberValue(raw.manual_disabled_count),
    };
  },

  async unban(authId: string): Promise<unknown> {
    return apiClient.post(`${BASE}/unban`, { auth_id: authId });
  },

  async unbanAll(body?: { auth_ids?: string[]; category?: string; lang?: string }): Promise<unknown> {
    return apiClient.post(`${BASE}/unban-all`, body || {});
  },

  async banDelete(body: {
    auth_ids?: string[];
    category?: string;
    all?: boolean;
    lang?: string;
  }): Promise<unknown> {
    const payload: Record<string, unknown> = {};
    if (body.lang) payload.lang = body.lang;
    if (body.auth_ids?.length) payload.auth_ids = body.auth_ids;
    if (body.category) payload.category = body.category;
    if (body.all) payload.category = 'all';
    return apiClient.post(`${BASE}/ban-delete`, payload);
  },

  async updateAutobanSettings(body: {
    autoban_enabled?: boolean;
    fallback_hours?: number;
  }): Promise<unknown> {
    return apiClient.post(`${BASE}/autoban-settings`, body);
  },
};
