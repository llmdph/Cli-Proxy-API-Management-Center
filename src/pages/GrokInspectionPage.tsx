import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { IconRefreshCw } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useNotificationStore } from '@/stores';
import {
  grokInspectionApi,
  type GrokAccountResult,
  type GrokBanEntry,
  type GrokInspectionSchedule,
  type GrokInspectionStatus,
} from '@/services/api/grokInspection';
import { getErrorMessage } from '@/utils/helpers';
import styles from './GrokInspectionPage.module.scss';

const WORKERS_MIN = 1;
const WORKERS_MAX = 16;
const WORKERS_DEFAULT = 6;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const PAGE_SIZE_DEFAULT = 20;

const FILTERS = [
  'all',
  'uninspected',
  'healthy',
  'permission_denied',
  'quota_exhausted',
  'spending_limit',
  'reauth',
  'no_think_stream',
  'other',
] as const;

type TimeSort = 'newest' | 'oldest';

const rowTimeMs = (row: GrokAccountResult) => {
  const probed = Date.parse(String(row.probed_at || ''));
  if (Number.isFinite(probed) && probed > 0) return probed;
  const mod = Number(row.file_mod_unix || 0);
  if (Number.isFinite(mod) && mod > 0) return mod * 1000;
  return 0;
};

const formatProbedAt = (row: GrokAccountResult) => {
  const ms = rowTimeMs(row);
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return row.probed_at || '—';
  }
};

const rowMatchesSearch = (row: GrokAccountResult, q: string) => {
  if (!q) return true;
  const hay = [row.name, row.email, row.file_name, row.auth_index, row.reason, row.classification]
    .map((v) => String(v || '').toLowerCase())
    .join('\n');
  return hay.includes(q);
};

const rowKey = (row: GrokAccountResult) =>
  row.auth_index || row.file_name || row.name || row.email || '';

const actionTargetName = (row: GrokAccountResult) =>
  row.file_name || row.name || row.auth_index || row.email || '';

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const classificationTone = (value: string) => {
  if (value === 'healthy') return styles.ok;
  if (value === 'reauth' || value === 'permission_denied') return styles.bad;
  if (value === 'quota_exhausted' || value === 'spending_limit' || value === 'no_think_stream') {
    return styles.warn;
  }
  if (value === 'uninspected') return styles.muted;
  return styles.muted;
};

const BAN_FILTERS = [
  'all',
  'unsynced',
  'quota',
  'spending_limit',
  'permission',
  'unauthorized',
  'manual',
] as const;

type BanFilter = (typeof BAN_FILTERS)[number];

const banCategoryOf = (ban: GrokBanEntry): Exclude<BanFilter, 'all' | 'unsynced'> | 'other' => {
  const direct = String(ban.category || '').trim().toLowerCase();
  if (
    direct === 'quota' ||
    direct === 'spending_limit' ||
    direct === 'permission' ||
    direct === 'unauthorized' ||
    direct === 'manual'
  ) {
    return direct;
  }
  const code = String(ban.error_code || '').trim().toLowerCase();
  if (!code) return 'other';
  if (code.includes('free-usage-exhausted') || code.includes('quota')) return 'quota';
  if (code.includes('spending-limit') || code.includes('402')) return 'spending_limit';
  if (code.includes('permission-denied') || code.includes('permission')) return 'permission';
  if (
    code.includes('unauthorized') ||
    code.includes('authentication_error') ||
    code.includes('invalid_token') ||
    code.includes('token_expired') ||
    code === '401' ||
    code === 'unauthenticated'
  ) {
    return 'unauthorized';
  }
  if (code.includes('manual-disabled') || code.includes('manual')) return 'manual';
  return 'other';
};

const formatRemain = (sec?: number) => {
  const value = Number(sec || 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  if (h >= 24 * 30) return 'manual';
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
};

const formatBanReasonKey = (ban: GrokBanEntry) => {
  const cat = banCategoryOf(ban);
  if (cat === 'quota') return 'ban_reason_quota';
  if (cat === 'spending_limit') return 'ban_reason_spending_limit';
  if (cat === 'permission') return 'ban_reason_permission';
  if (cat === 'unauthorized') return 'ban_reason_unauthorized';
  if (cat === 'manual') return 'ban_reason_manual';
  const code = String(ban.error_code || '').trim();
  return code || '-';
};

export function GrokInspectionPage() {
  const { t, i18n } = useTranslation();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en';

  const [status, setStatus] = useState<GrokInspectionStatus | null>(null);
  const [results, setResults] = useState<GrokAccountResult[]>([]);
  const [resultsGen, setResultsGen] = useState(0);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [search, setSearch] = useState('');
  const [timeSort, setTimeSort] = useState<TimeSort>('newest');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_DEFAULT);
  const [banPage, setBanPage] = useState(1);
  const [banPageSize, setBanPageSize] = useState<number>(PAGE_SIZE_DEFAULT);
  const [syncingUninspected, setSyncingUninspected] = useState(false);
  const didAutoSyncRef = useRef(false);
  const syncingUninspectedRef = useRef(false);
  const [workers, setWorkers] = useState(WORKERS_DEFAULT);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [onlyDisabled, setOnlyDisabled] = useState(false);
  const [sampleCount, setSampleCount] = useState('');
  const [samplePercent, setSamplePercent] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [scheduleDraft, setScheduleDraft] = useState<GrokInspectionSchedule | null>(null);
  const [bans, setBans] = useState<GrokBanEntry[]>([]);
  const [banMeta, setBanMeta] = useState<{
    unsynced_count?: number;
    quota_count?: number;
    spending_limit_count?: number;
    permission_count?: number;
    unauthorized_count?: number;
    manual_disabled_count?: number;
  }>({});
  const [banFilter, setBanFilter] = useState<BanFilter>('all');
  const [autobanEnabled, setAutobanEnabled] = useState(true);
  const [tab, setTab] = useState<'inspect' | 'schedule' | 'bans'>('inspect');

  const busy = Boolean(
    status?.running || status?.applying || (status?.unban && status.unban.running)
  );

  const mergeStatus = useCallback((next: GrokInspectionStatus, keepResults = true) => {
    setStatus(next);
    if (typeof next.results !== 'undefined') {
      setResults(next.results);
      setResultsGen(next.results_gen);
      return;
    }
    if (!keepResults) {
      setResults([]);
    }
  }, []);

  const refresh = useCallback(
    async (options?: { light?: boolean }) => {
      if (connectionStatus !== 'connected') return;
      const light = options?.light ?? false;
      setLoading(true);
      try {
        const next = await grokInspectionApi.status({
          includeResults: !light,
          lang,
        });
        if (light) {
          mergeStatus(next, true);
          if (next.results_gen !== resultsGen && !next.running && !next.applying) {
            const full = await grokInspectionApi.status({ includeResults: true, lang });
            mergeStatus(full, false);
          }
        } else {
          mergeStatus(next, false);
        }
        if (next.schedule) setScheduleDraft(next.schedule);
      } catch (error) {
        showNotification(getErrorMessage(error) || t('grok_inspection.load_error'), 'error');
      } finally {
        setLoading(false);
      }
    },
    [connectionStatus, lang, mergeStatus, resultsGen, showNotification, t]
  );

  const loadBans = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    try {
      const data = await grokInspectionApi.bans();
      setBans(data.bans);
      setBanMeta({
        unsynced_count:
          typeof data.unsynced_count === 'number'
            ? data.unsynced_count
            : data.bans.filter((item) => item.cpa_synced === false).length,
        quota_count: data.quota_count,
        spending_limit_count: data.spending_limit_count,
        permission_count: data.permission_count,
        unauthorized_count: data.unauthorized_count,
        manual_disabled_count: data.manual_disabled_count,
      });
      if (typeof data.enabled === 'boolean') setAutobanEnabled(data.enabled);
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.bans_error'), 'error');
    }
  }, [connectionStatus, showNotification, t]);

  const syncUninspected = useCallback(
    async (options?: { silent?: boolean }) => {
      if (connectionStatus !== 'connected' || busy || syncingUninspectedRef.current) {
        return { added: 0, skipped: true as const };
      }
      syncingUninspectedRef.current = true;
      setSyncingUninspected(true);
      try {
        const data = await grokInspectionApi.syncUninspected(lang);
        if (data.status) {
          mergeStatus(data.status, false);
          if (data.status.schedule) setScheduleDraft(data.status.schedule);
        } else {
          await refresh({ light: false });
        }
        const added = Number(data.added || 0);
        if (!options?.silent) {
          showNotification(
            added > 0
              ? t('grok_inspection.sync_uninspected_added', { count: added })
              : t('grok_inspection.sync_uninspected_none'),
            'success'
          );
        }
        return { added, skipped: false as const };
      } catch (error) {
        if (!options?.silent) {
          showNotification(
            getErrorMessage(error) || t('grok_inspection.sync_uninspected_error'),
            'error'
          );
        }
        return { added: 0, skipped: false as const };
      } finally {
        syncingUninspectedRef.current = false;
        setSyncingUninspected(false);
      }
    },
    [
      busy,
      connectionStatus,
      lang,
      mergeStatus,
      refresh,
      showNotification,
      t,
    ]
  );

  useHeaderRefresh(() => {
    void refresh({ light: false });
    if (tab === 'bans') void loadBans();
  }, connectionStatus === 'connected');

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      didAutoSyncRef.current = false;
      return;
    }
    void refresh({ light: false });
  }, [connectionStatus, refresh]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || busy || didAutoSyncRef.current) return;
    // Import missing accounts into "uninspected" without probing.
    void (async () => {
      const result = await syncUninspected({ silent: true });
      if (!result.skipped) {
        didAutoSyncRef.current = true;
      }
    })();
  }, [busy, connectionStatus, syncUninspected]);

  useEffect(() => {
    if (!busy || connectionStatus !== 'connected') return;
    const timer = window.setInterval(() => {
      void refresh({ light: true });
      if (tab === 'bans') void loadBans();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [busy, connectionStatus, refresh, tab, loadBans]);

  useEffect(() => {
    if (tab === 'bans') void loadBans();
  }, [tab, loadBans]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = results;
    if (filter === 'other') {
      const primary = new Set([
        'healthy',
        'permission_denied',
        'quota_exhausted',
        'spending_limit',
        'reauth',
        'no_think_stream',
        'uninspected',
      ]);
      rows = results.filter((row) => !primary.has(row.classification));
    } else if (filter !== 'all') {
      rows = results.filter((row) => row.classification === filter);
    }
    if (q) rows = rows.filter((row) => rowMatchesSearch(row, q));
    const sorted = [...rows].sort((a, b) => {
      const da = rowTimeMs(a);
      const db = rowTimeMs(b);
      if (da === db) {
        return String(rowKey(a)).localeCompare(String(rowKey(b)));
      }
      return timeSort === 'newest' ? db - da : da - db;
    });
    return sorted;
  }, [filter, results, search, timeSort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize) || 1);
  const currentPage = Math.min(page, totalPages);
  const pageOffset = (currentPage - 1) * pageSize;
  const paged = useMemo(
    () => filtered.slice(pageOffset, pageOffset + pageSize),
    [filtered, pageOffset, pageSize]
  );

  useEffect(() => {
    setPage(1);
  }, [filter, search, timeSort, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const summaryCount = (key: string) => {
    if (key === 'all') return status?.summary.total ?? results.length;
    if (key === 'other') {
      return (
        status?.summary.other ??
        results.filter((row) => {
          const primary = new Set([
            'healthy',
            'permission_denied',
            'quota_exhausted',
            'spending_limit',
            'reauth',
            'no_think_stream',
            'uninspected',
          ]);
          return !primary.has(row.classification);
        }).length
      );
    }
    if (key === 'uninspected') {
      return (
        status?.summary.uninspected ??
        results.filter((row) => row.classification === 'uninspected').length
      );
    }
    return status?.summary[key] ?? results.filter((row) => row.classification === key).length;
  };

  const startInspection = async (mode: 'full' | 'incremental' | 'sample' | 'filter') => {
    try {
      const workerCount = Number(workers);
      if (
        !Number.isInteger(workerCount) ||
        workerCount < WORKERS_MIN ||
        workerCount > WORKERS_MAX
      ) {
        throw new Error(t('grok_inspection.workers_invalid'));
      }
      const body = {
        lang,
        workers: workerCount,
        include_disabled: includeDisabled,
        only_disabled: onlyDisabled,
        incremental: mode === 'incremental',
        sample: mode === 'sample',
        sample_count: 0,
        sample_percent: 0,
        classifications: [] as string[],
      };
      if (mode === 'sample') {
        const count = sampleCount.trim() ? Number(sampleCount) : 0;
        const percent = samplePercent.trim() ? Number(samplePercent) : 0;
        if ((!count && !percent) || count < 0 || percent < 0 || percent > 100) {
          throw new Error(t('grok_inspection.sample_invalid'));
        }
        body.sample_count = count;
        body.sample_percent = percent;
      }
      if (mode === 'filter') {
        if (filter === 'all') throw new Error(t('grok_inspection.pick_category'));
        body.classifications = filter === 'other' ? ['other'] : [filter];
      }
      await grokInspectionApi.start(body);
      showNotification(t('grok_inspection.started'), 'success');
      await refresh({ light: true });
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.start_error'), 'error');
    }
  };

  const stopInspection = async () => {
    try {
      await grokInspectionApi.stop(lang);
      showNotification(t('grok_inspection.stopped'), 'success');
      await refresh({ light: false });
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.stop_error'), 'error');
    }
  };

  const applyRecommended = async () => {
    try {
      await grokInspectionApi.apply({ lang });
      showNotification(t('grok_inspection.apply_started'), 'success');
      await refresh({ light: true });
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.apply_error'), 'error');
    }
  };

  const batchForce = async (forceAction: 'disable' | 'enable' | 'delete' | 'refresh') => {
    const rows = filtered.filter((row) => {
      if (forceAction === 'disable') return !row.disabled;
      if (forceAction === 'enable') return row.disabled;
      return true;
    });
    const indexes = rows.map(rowKey).filter(Boolean);
    if (!indexes.length) {
      showNotification(t('grok_inspection.no_targets'), 'error');
      return;
    }
    if (forceAction === 'delete') {
      const ok = window.confirm(t('grok_inspection.delete_confirm_batch', { count: indexes.length }));
      if (!ok) return;
    }
    try {
      await grokInspectionApi.apply({
        lang,
        auth_indexes: indexes,
        force_action: forceAction,
      });
      showNotification(t('grok_inspection.apply_started'), 'success');
      await refresh({ light: true });
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.apply_error'), 'error');
    }
  };

  const waitRowAction = async (seq: number) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const light = await grokInspectionApi.status({ includeResults: false, lang });
      mergeStatus(light, true);
      const hit = (light.recent_row_actions || []).find((item) => item.seq === seq);
      if (hit) return hit;
      await sleep(200);
    }
    throw new Error(t('grok_inspection.action_timeout'));
  };

  const runRowAction = async (row: GrokAccountResult, act: 'disable' | 'enable' | 'delete' | 'refresh') => {
    const key = rowKey(row);
    if (!key || pendingKeys.has(key)) return;
    if (act === 'delete') {
      const ok = window.confirm(t('grok_inspection.delete_confirm', { name: row.name || key }));
      if (!ok) return;
    }
    setPendingKeys((prev) => new Set(prev).add(key));
    try {
      const result = await grokInspectionApi.action({
        lang,
        auth_index: row.auth_index || '',
        name: actionTargetName(row),
        disabled: act === 'disable',
        delete: act === 'delete',
        refresh: act === 'refresh',
      });
      if (!result.action_seq) throw new Error(result.error || t('grok_inspection.no_action_seq'));
      const confirmed = await waitRowAction(result.action_seq);
      if (!confirmed.ok) throw new Error(confirmed.error || t('grok_inspection.action_failed'));
      showNotification(t('grok_inspection.action_ok'), 'success');
      await refresh({ light: false });
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.action_failed'), 'error');
      await refresh({ light: false });
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const exportFiltered = (format: 'json' | 'txt') => {
    const payload =
      format === 'json'
        ? JSON.stringify(filtered, null, 2)
        : filtered
            .map(
              (row) =>
                `${rowKey(row)}\t${row.classification}\t${row.action}\t${row.disabled ? 'disabled' : 'enabled'}\t${row.reason}`
            )
            .join('\n');
    const blob = new Blob([payload], {
      type: format === 'json' ? 'application/json' : 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `grok-inspection.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const saveSchedule = async () => {
    if (!scheduleDraft) return;
    try {
      const saved = await grokInspectionApi.updateSchedule(scheduleDraft);
      setScheduleDraft(saved);
      showNotification(t('grok_inspection.schedule_saved'), 'success');
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.schedule_error'), 'error');
    }
  };

  const filteredBans = useMemo(() => {
    if (banFilter === 'all') return bans;
    if (banFilter === 'unsynced') return bans.filter((item) => item.cpa_synced === false);
    return bans.filter((item) => banCategoryOf(item) === banFilter);
  }, [banFilter, bans]);

  const banTotalPages = Math.max(1, Math.ceil(filteredBans.length / banPageSize) || 1);
  const banCurrentPage = Math.min(banPage, banTotalPages);
  const banPageOffset = (banCurrentPage - 1) * banPageSize;
  const pagedBans = useMemo(
    () => filteredBans.slice(banPageOffset, banPageOffset + banPageSize),
    [banPageOffset, banPageSize, filteredBans]
  );

  useEffect(() => {
    setBanPage(1);
  }, [banFilter, banPageSize]);

  useEffect(() => {
    if (banPage > banTotalPages) setBanPage(banTotalPages);
  }, [banPage, banTotalPages]);

  const banSummaryCount = (key: BanFilter) => {
    if (key === 'all') return bans.length;
    if (key === 'unsynced') {
      return (
        banMeta.unsynced_count ??
        bans.filter((item) => item.cpa_synced === false).length
      );
    }
    if (key === 'quota') {
      return banMeta.quota_count ?? bans.filter((item) => banCategoryOf(item) === 'quota').length;
    }
    if (key === 'spending_limit') {
      return (
        banMeta.spending_limit_count ??
        bans.filter((item) => banCategoryOf(item) === 'spending_limit').length
      );
    }
    if (key === 'permission') {
      return (
        banMeta.permission_count ??
        bans.filter((item) => banCategoryOf(item) === 'permission').length
      );
    }
    if (key === 'unauthorized') {
      return (
        banMeta.unauthorized_count ??
        bans.filter((item) => banCategoryOf(item) === 'unauthorized').length
      );
    }
    if (key === 'manual') {
      return (
        banMeta.manual_disabled_count ??
        bans.filter((item) => banCategoryOf(item) === 'manual').length
      );
    }
    return 0;
  };

  const banJobRunning = Boolean(status?.unban && (status.unban as { running?: boolean }).running);

  const runBanDelete = async (mode: 'filter' | 'all') => {
    const targets =
      mode === 'all'
        ? bans.map((item) => item.auth_id).filter(Boolean)
        : filteredBans.map((item) => item.auth_id).filter(Boolean);
    if (!targets.length) {
      showNotification(t('grok_inspection.no_targets'), 'error');
      return;
    }
    const ok = window.confirm(
      t('grok_inspection.ban_delete_confirm', { count: targets.length })
    );
    if (!ok) return;
    try {
      await grokInspectionApi.banDelete({
        lang,
        all: mode === 'all',
        category: mode === 'all' ? 'all' : banFilter === 'all' || banFilter === 'unsynced' ? undefined : banFilter,
        auth_ids: mode === 'all' ? undefined : targets,
      });
      showNotification(t('grok_inspection.ban_delete_started'), 'success');
      await refresh({ light: true });
      await loadBans();
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.ban_delete_error'), 'error');
    }
  };

  const runBanUnban = async (mode: 'filter' | 'all') => {
    const targets =
      mode === 'all'
        ? bans.map((item) => item.auth_id).filter(Boolean)
        : filteredBans.map((item) => item.auth_id).filter(Boolean);
    if (!targets.length) {
      showNotification(t('grok_inspection.no_targets'), 'error');
      return;
    }
    const ok = window.confirm(
      mode === 'all'
        ? t('grok_inspection.unban_all_confirm', { count: targets.length })
        : t('grok_inspection.unban_filter_confirm', {
            count: targets.length,
            filter: t(`grok_inspection.ban_filter_${banFilter}`),
          })
    );
    if (!ok) return;
    try {
      if (mode === 'all') {
        await grokInspectionApi.unbanAll({});
      } else {
        await grokInspectionApi.unbanAll({
          lang,
          auth_ids: targets,
          category: banFilter === 'all' || banFilter === 'unsynced' ? undefined : banFilter,
        });
      }
      showNotification(
        mode === 'all'
          ? t('grok_inspection.unban_all_started')
          : t('grok_inspection.unban_filter_started', { count: targets.length }),
        'success'
      );
      await refresh({ light: true });
      await loadBans();
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.unban_error'), 'error');
    }
  };

  const stopBanJob = async () => {
    try {
      await grokInspectionApi.stop(lang);
      showNotification(t('grok_inspection.stopped'), 'success');
      await refresh({ light: true });
      await loadBans();
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.stop_error'), 'error');
    }
  };

  const inspectOne = async (row: GrokAccountResult) => {
    const key = rowKey(row);
    if (!key || pendingKeys.has(key) || busy) return;
    // Prefer stable auth_index; fall back to file name / row key once only.
    const target =
      String(row.auth_index || '').trim() ||
      String(row.file_name || '').trim() ||
      String(key || '').trim();
    if (!target) return;
    setPendingKeys((prev) => new Set(prev).add(key));
    try {
      await grokInspectionApi.start({
        lang,
        workers: 1,
        include_disabled: true,
        only_disabled: false,
        incremental: false,
        sample: false,
        auth_indexes: [target],
      });
      showNotification(t('grok_inspection.inspect_one_started'), 'success');
      await refresh({ light: true });
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.start_error'), 'error');
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const progressText = (() => {
    if (!status) return '';
    if (status.running) {
      return t('grok_inspection.progress_running', {
        done: status.done,
        total: status.total,
        workers: status.workers,
      });
    }
    if (status.applying) {
      return t('grok_inspection.progress_applying', {
        done: status.apply_done,
        total: status.apply_total,
      });
    }
    if (status.stopped) return t('grok_inspection.progress_stopped');
    if (status.finished_at) {
      return t('grok_inspection.progress_done', { done: status.done, total: results.length });
    }
    return t('grok_inspection.progress_idle');
  })();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>{t('grok_inspection.title')}</h1>
          <p className={styles.subtitle}>{t('grok_inspection.subtitle')}</p>
        </div>
        <div className={styles.meta}>
          {loading ? t('common.loading') : progressText}
        </div>
      </div>

      <div className={styles.toolbar}>
        <Button variant={tab === 'inspect' ? 'primary' : 'secondary'} onClick={() => setTab('inspect')}>
          {t('grok_inspection.tab_inspect')}
        </Button>
        <Button
          variant={tab === 'schedule' ? 'primary' : 'secondary'}
          onClick={() => setTab('schedule')}
        >
          {t('grok_inspection.tab_schedule')}
        </Button>
        <Button variant={tab === 'bans' ? 'primary' : 'secondary'} onClick={() => setTab('bans')}>
          {t('grok_inspection.tab_bans')}
        </Button>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={() => void refresh({ light: false })}
            disabled={connectionStatus !== 'connected'}
          >
            <IconRefreshCw size={16} />
            {t('grok_inspection.refresh')}
          </Button>
        </div>
      </div>

      {tab === 'inspect' && (
        <div className={styles.stack}>
          <Card title={t('grok_inspection.controls')}>
            <div className={styles.toolbar}>
              <label className={styles.field}>
                {t('grok_inspection.workers')}
                <input
                  className={styles.input}
                  type="number"
                  min={WORKERS_MIN}
                  max={WORKERS_MAX}
                  value={workers}
                  onChange={(event) => setWorkers(Number(event.target.value) || WORKERS_DEFAULT)}
                />
              </label>
              <label className={styles.field}>
                {t('grok_inspection.sample_count')}
                <input
                  className={styles.input}
                  value={sampleCount}
                  onChange={(event) => setSampleCount(event.target.value)}
                />
              </label>
              <label className={styles.field}>
                {t('grok_inspection.sample_percent')}
                <input
                  className={styles.input}
                  value={samplePercent}
                  onChange={(event) => setSamplePercent(event.target.value)}
                />
              </label>
              <div className={styles.checks}>
                <label className={styles.field}>
                  <ToggleSwitch
                    checked={includeDisabled}
                    onChange={(checked) => {
                      setIncludeDisabled(checked);
                      if (checked) setOnlyDisabled(false);
                    }}
                  />
                  {t('grok_inspection.include_disabled')}
                </label>
                <label className={styles.field}>
                  <ToggleSwitch
                    checked={onlyDisabled}
                    onChange={(checked) => {
                      setOnlyDisabled(checked);
                      if (checked) setIncludeDisabled(false);
                    }}
                  />
                  {t('grok_inspection.only_disabled')}
                </label>
              </div>
            </div>
            <div className={styles.toolbar}>
              <Button onClick={() => void startInspection('full')} disabled={busy}>
                {t('grok_inspection.start_full')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void startInspection('incremental')}
                disabled={busy}
              >
                {t('grok_inspection.start_incremental')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void syncUninspected()}
                disabled={busy || syncingUninspected}
              >
                {t('grok_inspection.sync_uninspected')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void startInspection('sample')}
                disabled={busy}
              >
                {t('grok_inspection.start_sample')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void startInspection('filter')}
                disabled={busy || filter === 'all'}
              >
                {t('grok_inspection.start_filter')}
              </Button>
              <Button variant="secondary" onClick={() => void stopInspection()} disabled={!busy}>
                {t('grok_inspection.stop')}
              </Button>
              <Button variant="secondary" onClick={() => void applyRecommended()} disabled={busy}>
                {t('grok_inspection.apply_recommended')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void batchForce('disable')}
                disabled={busy}
              >
                {t('grok_inspection.batch_disable')}
              </Button>
              <Button variant="secondary" onClick={() => void batchForce('enable')} disabled={busy}>
                {t('grok_inspection.batch_enable')}
              </Button>
              <Button variant="secondary" onClick={() => void batchForce('refresh')} disabled={busy}>
                {t('grok_inspection.batch_refresh')}
              </Button>
              <Button variant="secondary" onClick={() => void batchForce('delete')} disabled={busy}>
                {t('grok_inspection.batch_delete')}
              </Button>
              <Button variant="secondary" onClick={() => exportFiltered('json')}>
                {t('grok_inspection.export_json')}
              </Button>
              <Button variant="secondary" onClick={() => exportFiltered('txt')}>
                {t('grok_inspection.export_txt')}
              </Button>
            </div>
            <div className={styles.progress}>{progressText}</div>
          </Card>

          <div className={styles.summaryRow}>
            {FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                className={`${styles.chip} ${filter === key ? styles.chipActive : ''}`}
                onClick={() => setFilter(key)}
              >
                {t(`grok_inspection.filter_${key}`)} ({summaryCount(key)})
              </button>
            ))}
          </div>

          <div className={styles.toolbar}>
            <label className={styles.field}>
              {t('grok_inspection.search')}
              <input
                className={styles.searchInput}
                value={search}
                placeholder={t('grok_inspection.search_placeholder')}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t('grok_inspection.time_sort')}
              <select
                className={styles.input}
                style={{ width: 140 }}
                value={timeSort}
                onChange={(event) => setTimeSort(event.target.value as TimeSort)}
              >
                <option value="newest">{t('grok_inspection.time_sort_newest')}</option>
                <option value="oldest">{t('grok_inspection.time_sort_oldest')}</option>
              </select>
            </label>
            <label className={styles.field}>
              {t('grok_inspection.page_size')}
              <select
                className={styles.input}
                style={{ width: 88 }}
                value={pageSize}
                onChange={(event) => setPageSize(Number(event.target.value) || PAGE_SIZE_DEFAULT)}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.muted}>
              {t('grok_inspection.filtered_count', { count: filtered.length })}
            </div>
          </div>

          <Card title={t('grok_inspection.results_title')}>
            {filtered.length === 0 ? (
              <EmptyState
                title={t('grok_inspection.empty')}
                description={t('grok_inspection.empty_hint')}
              />
            ) : (
              <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('grok_inspection.col_name')}</TableHead>
                    <TableHead>{t('grok_inspection.col_class')}</TableHead>
                    <TableHead>{t('grok_inspection.col_action')}</TableHead>
                    <TableHead>{t('grok_inspection.col_status')}</TableHead>
                    <TableHead>{t('grok_inspection.col_time')}</TableHead>
                    <TableHead>{t('grok_inspection.col_reason')}</TableHead>
                    <TableHead>{t('grok_inspection.col_ops')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.map((row) => {
                    const key = rowKey(row);
                    const pending = pendingKeys.has(key);
                    return (
                      <TableRow key={key}>
                        <TableCell>
                          <div>{row.name || key}</div>
                          <div className={`${styles.mono} ${styles.muted}`}>
                            {row.email || row.file_name || row.auth_index}
                          </div>
                        </TableCell>
                        <TableCell className={classificationTone(row.classification)}>
                          {row.classification}
                        </TableCell>
                        <TableCell>{row.action || '-'}</TableCell>
                        <TableCell className={styles.nowrap}>
                          {row.disabled
                            ? t('grok_inspection.disabled')
                            : t('grok_inspection.enabled')}
                        </TableCell>
                        <TableCell className={`${styles.nowrap} ${styles.muted}`}>
                          {formatProbedAt(row)}
                        </TableCell>
                        <TableCell className={styles.reason} title={row.reason}>
                          {row.reason || '-'}
                        </TableCell>
                        <TableCell>
                          <div className={styles.rowActions}>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending || busy || row.disabled}
                              onClick={() => void runRowAction(row, 'disable')}
                            >
                              {t('grok_inspection.action_disable')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending || busy || !row.disabled}
                              onClick={() => void runRowAction(row, 'enable')}
                            >
                              {t('grok_inspection.action_enable')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending || busy}
                              onClick={() => void inspectOne(row)}
                            >
                              {t('grok_inspection.action_inspect')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending || busy}
                              onClick={() => void runRowAction(row, 'refresh')}
                            >
                              {t('grok_inspection.action_refresh')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pending || busy}
                              onClick={() => void runRowAction(row, 'delete')}
                            >
                              {t('grok_inspection.action_delete')}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('grok_inspection.pagination_prev')}
                </Button>
                <div className={styles.pageInfo}>
                  {t('grok_inspection.pagination_info', {
                    current: currentPage,
                    total: totalPages,
                    count: filtered.length,
                    from: filtered.length === 0 ? 0 : pageOffset + 1,
                    to: Math.min(pageOffset + paged.length, filtered.length),
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('grok_inspection.pagination_next')}
                </Button>
              </div>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'schedule' && scheduleDraft && (
        <Card title={t('grok_inspection.schedule_title')}>
          <div className={styles.grid2}>
            <label className={styles.field}>
              <ToggleSwitch
                checked={scheduleDraft.enabled}
                onChange={(checked) => setScheduleDraft({ ...scheduleDraft, enabled: checked })}
              />
              {t('grok_inspection.schedule_enabled')}
            </label>
            <label className={styles.field}>
              {t('grok_inspection.schedule_interval')}
              <input
                className={styles.input}
                type="number"
                min={1}
                value={scheduleDraft.interval_minutes}
                onChange={(event) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    interval_minutes: Number(event.target.value) || 60,
                  })
                }
              />
            </label>
            <label className={styles.field}>
              {t('grok_inspection.workers')}
              <input
                className={styles.input}
                type="number"
                min={WORKERS_MIN}
                max={WORKERS_MAX}
                value={scheduleDraft.workers}
                onChange={(event) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    workers: Number(event.target.value) || WORKERS_DEFAULT,
                  })
                }
              />
            </label>
            <label className={styles.field}>
              {t('grok_inspection.schedule_scope')}
              <select
                className={styles.input}
                style={{ width: 120 }}
                value={scheduleDraft.scope || 'full'}
                onChange={(event) =>
                  setScheduleDraft({ ...scheduleDraft, scope: event.target.value })
                }
              >
                <option value="full">full</option>
                <option value="sample">sample</option>
              </select>
            </label>
          </div>
          <div className={styles.grid2}>
            <label className={styles.field}>
              <ToggleSwitch
                checked={Boolean(scheduleDraft.include_disabled)}
                onChange={(checked) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    include_disabled: checked,
                    only_disabled: checked ? false : scheduleDraft.only_disabled,
                  })
                }
              />
              {t('grok_inspection.schedule_include_disabled')}
            </label>
            <label className={styles.field}>
              <ToggleSwitch
                checked={Boolean(scheduleDraft.only_disabled)}
                onChange={(checked) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    only_disabled: checked,
                    include_disabled: checked ? false : scheduleDraft.include_disabled,
                  })
                }
              />
              {t('grok_inspection.schedule_only_disabled')}
            </label>
            <label className={styles.field}>
              {t('grok_inspection.schedule_403_action')}
              <select
                className={styles.input}
                style={{ width: 120 }}
                value={scheduleDraft.permission_denied_action || 'disable'}
                onChange={(event) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    permission_denied_action: event.target.value,
                  })
                }
              >
                <option value="disable">{t('grok_inspection.schedule_action_disable')}</option>
                <option value="delete">{t('grok_inspection.schedule_action_delete')}</option>
              </select>
            </label>
            <label className={styles.field}>
              {t('grok_inspection.schedule_402_action')}
              <select
                className={styles.input}
                style={{ width: 120 }}
                value={scheduleDraft.spending_limit_action || 'disable'}
                onChange={(event) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    spending_limit_action: event.target.value,
                  })
                }
              >
                <option value="disable">{t('grok_inspection.schedule_action_disable')}</option>
                <option value="delete">{t('grok_inspection.schedule_action_delete')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <ToggleSwitch
                checked={Boolean(scheduleDraft.auto_recover_healthy)}
                onChange={(checked) =>
                  setScheduleDraft({ ...scheduleDraft, auto_recover_healthy: checked })
                }
              />
              {t('grok_inspection.schedule_auto_recover')}
            </label>
          </div>
          <div className={styles.muted} style={{ marginBottom: 12 }}>
            {scheduleDraft.next_run_at
              ? t('grok_inspection.next_run', { time: scheduleDraft.next_run_at })
              : t('grok_inspection.no_next_run')}
            {scheduleDraft.last_status ? ` · ${scheduleDraft.last_status}` : ''}
          </div>
          <Button onClick={() => void saveSchedule()}>{t('grok_inspection.save_schedule')}</Button>
        </Card>
      )}

      {tab === 'bans' && (
        <Card title={t('grok_inspection.bans_title')}>
          <div className={styles.toolbar}>
            <label className={styles.field}>
              <ToggleSwitch
                checked={autobanEnabled}
                onChange={(checked) => {
                  setAutobanEnabled(checked);
                  void grokInspectionApi
                    .updateAutobanSettings({ autoban_enabled: checked })
                    .then(() => showNotification(t('grok_inspection.autoban_saved'), 'success'))
                    .catch((error) =>
                      showNotification(
                        getErrorMessage(error) || t('grok_inspection.autoban_error'),
                        'error'
                      )
                    );
                }}
              />
              {t('grok_inspection.autoban_enabled')}
            </label>
            <Button variant="secondary" onClick={() => void loadBans()}>
              {t('grok_inspection.refresh')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void runBanUnban('filter')}
              disabled={!filteredBans.length || banJobRunning}
            >
              {t('grok_inspection.ban_unban_filter')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void runBanUnban('all')}
              disabled={!bans.length || banJobRunning}
            >
              {t('grok_inspection.unban_all')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void runBanDelete('filter')}
              disabled={!filteredBans.length || banJobRunning}
            >
              {t('grok_inspection.ban_delete_filter')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void runBanDelete('all')}
              disabled={!bans.length || banJobRunning}
            >
              {t('grok_inspection.ban_delete_all')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void stopBanJob()}
              disabled={!banJobRunning}
            >
              {t('grok_inspection.ban_stop')}
            </Button>
          </div>
          <div className={styles.muted} style={{ marginBottom: 8 }}>
            {banFilter === 'all'
              ? t('grok_inspection.ban_filter_hint_all')
              : t('grok_inspection.ban_filter_current', {
                  filter: t(`grok_inspection.ban_filter_${banFilter}`),
                  count: filteredBans.length,
                })}
            {banJobRunning ? ` · ${t('grok_inspection.ban_job_running')}` : ''}
          </div>

          {(banMeta.unsynced_count ?? bans.filter((item) => item.cpa_synced === false).length) >
            0 && (
            <div className={styles.warnBanner}>
              {t('grok_inspection.ban_unsynced_banner', {
                count:
                  banMeta.unsynced_count ??
                  bans.filter((item) => item.cpa_synced === false).length,
              })}
            </div>
          )}

          <div className={styles.summaryRow}>
            {BAN_FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                className={`${styles.chip} ${banFilter === key ? styles.chipActive : ''}`}
                onClick={() => setBanFilter(key)}
              >
                {t(`grok_inspection.ban_filter_${key}`)} ({banSummaryCount(key)})
              </button>
            ))}
          </div>

          <div className={styles.toolbar}>
            <label className={styles.field}>
              {t('grok_inspection.page_size')}
              <select
                className={styles.input}
                style={{ width: 88 }}
                value={banPageSize}
                onChange={(event) => setBanPageSize(Number(event.target.value) || PAGE_SIZE_DEFAULT)}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.muted}>
              {t('grok_inspection.filtered_count', { count: filteredBans.length })}
            </div>
          </div>

          {filteredBans.length === 0 ? (
            <EmptyState title={t('grok_inspection.bans_empty')} />
          ) : (
            <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('grok_inspection.ban_col_auth')}</TableHead>
                  <TableHead>{t('grok_inspection.ban_col_reason')}</TableHead>
                  <TableHead>{t('grok_inspection.ban_col_banned_at')}</TableHead>
                  <TableHead>{t('grok_inspection.ban_col_reset')}</TableHead>
                  <TableHead>{t('grok_inspection.ban_col_remain')}</TableHead>
                  <TableHead>{t('grok_inspection.ban_sync')}</TableHead>
                  <TableHead>{t('grok_inspection.col_ops')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedBans.map((ban) => {
                  const synced = ban.cpa_synced === true;
                  const syncLabel = synced
                    ? t('grok_inspection.ban_synced')
                    : t('grok_inspection.ban_unsynced');
                  const syncText = ban.cpa_sync_error
                    ? `${syncLabel} · ${ban.cpa_sync_error}`
                    : syncLabel;
                  return (
                    <TableRow key={ban.auth_id}>
                      <TableCell className={styles.mono}>{ban.auth_id}</TableCell>
                      <TableCell>
                        {(() => {
                          const reasonKey = formatBanReasonKey(ban);
                          return reasonKey.startsWith('ban_reason_')
                            ? t(`grok_inspection.${reasonKey}`)
                            : reasonKey;
                        })()}
                      </TableCell>
                      <TableCell className={styles.muted}>{ban.banned_at || '-'}</TableCell>
                      <TableCell className={styles.muted}>
                        {ban.reset_source || ban.reset_at || '-'}
                      </TableCell>
                      <TableCell className={styles.nowrap}>
                        {formatRemain(ban.remaining_seconds)}
                      </TableCell>
                      <TableCell className={synced ? styles.ok : styles.warn} title={syncText}>
                        {syncText}
                      </TableCell>
                      <TableCell>
                        <div className={styles.rowActions}>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void grokInspectionApi
                                .unban(ban.auth_id)
                                .then(() => loadBans())
                                .catch((error) =>
                                  showNotification(
                                    getErrorMessage(error) || t('grok_inspection.unban_error'),
                                    'error'
                                  )
                                )
                            }
                          >
                            {t('grok_inspection.unban')}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void grokInspectionApi
                                .banDelete({ lang, auth_ids: [ban.auth_id] })
                                .then(() => {
                                  showNotification(
                                    t('grok_inspection.ban_delete_started'),
                                    'success'
                                  );
                                  return loadBans();
                                })
                                .catch((error) =>
                                  showNotification(
                                    getErrorMessage(error) || t('grok_inspection.ban_delete_error'),
                                    'error'
                                  )
                                )
                            }
                          >
                            {t('grok_inspection.ban_delete')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBanPage((p) => Math.max(1, p - 1))}
                disabled={banCurrentPage <= 1}
              >
                {t('grok_inspection.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('grok_inspection.pagination_info', {
                  current: banCurrentPage,
                  total: banTotalPages,
                  count: filteredBans.length,
                  from: filteredBans.length === 0 ? 0 : banPageOffset + 1,
                  to: Math.min(banPageOffset + pagedBans.length, filteredBans.length),
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBanPage((p) => Math.min(banTotalPages, p + 1))}
                disabled={banCurrentPage >= banTotalPages}
              >
                {t('grok_inspection.pagination_next')}
              </Button>
            </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
