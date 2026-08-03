import { useCallback, useEffect, useMemo, useState } from 'react';
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

const FILTERS = [
  'all',
  'healthy',
  'permission_denied',
  'quota_exhausted',
  'spending_limit',
  'reauth',
  'other',
] as const;

const rowKey = (row: GrokAccountResult) =>
  row.auth_index || row.file_name || row.name || row.email || '';

const actionTargetName = (row: GrokAccountResult) =>
  row.file_name || row.name || row.auth_index || row.email || '';

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const classificationTone = (value: string) => {
  if (value === 'healthy') return styles.ok;
  if (value === 'reauth' || value === 'permission_denied') return styles.bad;
  if (value === 'quota_exhausted' || value === 'spending_limit') return styles.warn;
  return styles.muted;
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
  const [workers, setWorkers] = useState(WORKERS_DEFAULT);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [onlyDisabled, setOnlyDisabled] = useState(false);
  const [sampleCount, setSampleCount] = useState('');
  const [samplePercent, setSamplePercent] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [scheduleDraft, setScheduleDraft] = useState<GrokInspectionSchedule | null>(null);
  const [bans, setBans] = useState<GrokBanEntry[]>([]);
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
      if (typeof data.enabled === 'boolean') setAutobanEnabled(data.enabled);
    } catch (error) {
      showNotification(getErrorMessage(error) || t('grok_inspection.bans_error'), 'error');
    }
  }, [connectionStatus, showNotification, t]);

  useHeaderRefresh(() => {
    void refresh({ light: false });
    if (tab === 'bans') void loadBans();
  }, connectionStatus === 'connected');

  useEffect(() => {
    void refresh({ light: false });
  }, [refresh]);

  useEffect(() => {
    if (!busy || connectionStatus !== 'connected') return;
    const timer = window.setInterval(() => {
      void refresh({ light: true });
    }, 1200);
    return () => window.clearInterval(timer);
  }, [busy, connectionStatus, refresh]);

  useEffect(() => {
    if (tab === 'bans') void loadBans();
  }, [tab, loadBans]);

  const filtered = useMemo(() => {
    if (filter === 'all') return results;
    if (filter === 'other') {
      const primary = new Set([
        'healthy',
        'permission_denied',
        'quota_exhausted',
        'spending_limit',
        'reauth',
      ]);
      return results.filter((row) => !primary.has(row.classification));
    }
    return results.filter((row) => row.classification === filter);
  }, [filter, results]);

  const summaryCount = (key: string) => {
    if (key === 'all') return status?.summary.total ?? results.length;
    if (key === 'other') return status?.summary.other ?? 0;
    return status?.summary[key] ?? 0;
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

  const batchForce = async (forceAction: 'disable' | 'enable' | 'delete') => {
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

  const runRowAction = async (row: GrokAccountResult, act: 'disable' | 'enable' | 'delete') => {
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

          <Card title={t('grok_inspection.results_title')}>
            {filtered.length === 0 ? (
              <EmptyState
                title={t('grok_inspection.empty')}
                description={t('grok_inspection.empty_hint')}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('grok_inspection.col_name')}</TableHead>
                    <TableHead>{t('grok_inspection.col_class')}</TableHead>
                    <TableHead>{t('grok_inspection.col_action')}</TableHead>
                    <TableHead>{t('grok_inspection.col_status')}</TableHead>
                    <TableHead>{t('grok_inspection.col_reason')}</TableHead>
                    <TableHead>{t('grok_inspection.col_ops')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
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
              onClick={() =>
                void grokInspectionApi
                  .unbanAll()
                  .then(() => loadBans())
                  .catch((error) =>
                    showNotification(
                      getErrorMessage(error) || t('grok_inspection.unban_error'),
                      'error'
                    )
                  )
              }
              disabled={!bans.length}
            >
              {t('grok_inspection.unban_all')}
            </Button>
          </div>
          {bans.length === 0 ? (
            <EmptyState title={t('grok_inspection.bans_empty')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>auth_id</TableHead>
                  <TableHead>error</TableHead>
                  <TableHead>reset</TableHead>
                  <TableHead>{t('grok_inspection.col_ops')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bans.map((ban) => (
                  <TableRow key={ban.auth_id}>
                    <TableCell className={styles.mono}>{ban.auth_id}</TableCell>
                    <TableCell>{ban.error_code || '-'}</TableCell>
                    <TableCell className={styles.muted}>{ban.reset_at || '-'}</TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
