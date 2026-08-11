import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { IconEye, IconRefreshCw } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useNotificationStore } from '@/stores';
import {
  llmRequestLogsApi,
  type LLMRequestLogEntry,
} from '@/services/api/llmRequestLogs';
import { getErrorMessage } from '@/utils/helpers';
import { formatDateTimeValue, maskApiKey } from '@/utils/format';
import styles from './LLMRequestLogsPage.module.scss';

const PAGE_SIZE = 50;

export function LLMRequestLogsPage() {
  const { t, i18n } = useTranslation();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [items, setItems] = useState<LLMRequestLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [detailEntry, setDetailEntry] = useState<LLMRequestLogEntry | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const loadLogs = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    setLoading(true);
    try {
      const response = await llmRequestLogsApi.fetchLogs({
        limit: PAGE_SIZE,
        offset: (Math.max(1, page) - 1) * PAGE_SIZE,
      });
      setItems(response.items);
      setTotal(response.total);
      const pages = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
      if (page > pages) {
        setPage(pages);
      }
      setUpdatedAt(new Date());
    } catch (error) {
      showNotification(getErrorMessage(error) || t('llm_request_logs.load_error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [connectionStatus, page, showNotification, t]);

  const handleClear = useCallback(async () => {
    if (connectionStatus !== 'connected' || clearing) return;
    if (!window.confirm(t('llm_request_logs.clear_confirm'))) return;
    setClearing(true);
    try {
      const result = await llmRequestLogsApi.clearLogs();
      setPage(1);
      setItems([]);
      setTotal(0);
      setUpdatedAt(new Date());
      showNotification(
        t('llm_request_logs.clear_ok', { count: result.cleared }),
        'success',
      );
      await loadLogs();
    } catch (error) {
      showNotification(getErrorMessage(error) || t('llm_request_logs.clear_error'), 'error');
    } finally {
      setClearing(false);
    }
  }, [clearing, connectionStatus, loadLogs, showNotification, t]);

  useHeaderRefresh(loadLogs, connectionStatus === 'connected');

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!autoRefresh || connectionStatus !== 'connected') return;
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, connectionStatus, loadLogs]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>{t('llm_request_logs.title')}</h1>
          <p className={styles.subtitle}>{t('llm_request_logs.subtitle')}</p>
        </div>
        <div className={styles.meta}>
          {t('llm_request_logs.total', { count: total })}
          {updatedAt
            ? ` · ${t('llm_request_logs.updated_at', {
                time: updatedAt.toLocaleTimeString(i18n.language),
              })}`
            : null}
        </div>
      </div>

      <Card
        title={t('llm_request_logs.table_title')}
        extra={
          <div className={styles.toolbar}>
            <label className={styles.autoRefresh}>
              <ToggleSwitch checked={autoRefresh} onChange={setAutoRefresh} />
              <span>{t('llm_request_logs.auto_refresh')}</span>
            </label>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleClear()}
              disabled={
                clearing || loading || connectionStatus !== 'connected' || total === 0
              }
            >
              {t('llm_request_logs.clear')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void loadLogs()}
              disabled={loading || connectionStatus !== 'connected'}
            >
              <IconRefreshCw size={16} />
              {t('llm_request_logs.refresh')}
            </Button>
          </div>
        }
      >
        {items.length === 0 ? (
          <EmptyState
            title={loading ? t('llm_request_logs.loading') : t('llm_request_logs.empty')}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('llm_request_logs.col_time')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_token')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_group')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_type')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_model')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_latency')}</TableHead>
                  <TableHead alignRight>{t('llm_request_logs.col_prompt')}</TableHead>
                  <TableHead alignRight>{t('llm_request_logs.col_completion')}</TableHead>
                  <TableHead alignRight>{t('llm_request_logs.col_cost')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_exit_ip')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_thinking_level')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_thinking_field')}</TableHead>
                  <TableHead>{t('llm_request_logs.col_detail')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((entry) => (
                  <TableRow key={entry.id || `${entry.time}-${entry.request_id}-${entry.model}`}>
                    <TableCell>
                      <span className={styles.nowrap}>
                        {formatDateTimeValue(entry.time, i18n.language) || '-'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={styles.mono} title={entry.token}>
                        {maskApiKey(entry.token) || '-'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {entry.group ? <span className={styles.pill}>{entry.group}</span> : '-'}
                    </TableCell>
                    <TableCell>
                      <span className={entry.failed ? styles.bad : styles.ok}>
                        {entry.type || '-'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={styles.nowrap}>{entry.model || '-'}</span>
                    </TableCell>
                    <TableCell>
                      <span className={styles.nowrap}>
                        {entry.latency_ms}ms / {entry.ttft_ms}ms
                      </span>
                    </TableCell>
                    <TableCell alignRight>{entry.prompt_tokens}</TableCell>
                    <TableCell alignRight>{entry.completion_tokens}</TableCell>
                    <TableCell alignRight>{entry.cost}</TableCell>
                    <TableCell>
                      <div className={styles.exitCell}>
                        <span>{entry.exit_ip || '-'}</span>
                        {entry.exit_node ? (
                          <span className={styles.muted}>{entry.exit_node}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>{entry.thinking_level || '-'}</TableCell>
                    <TableCell>
                      {entry.has_thinking ? (
                        <span className={styles.ok}>
                          {t('llm_request_logs.thinking_yes', { length: entry.thinking_len })}
                        </span>
                      ) : (
                        <span className={styles.muted}>{t('llm_request_logs.thinking_no')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDetailEntry(entry)}
                        aria-label={t('llm_request_logs.view_detail')}
                      >
                        <IconEye size={16} />
                        {t('llm_request_logs.view_detail')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1 || loading}
              >
                {t('llm_request_logs.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('llm_request_logs.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: total,
                  from: total === 0 ? 0 : offset + 1,
                  to: Math.min(offset + items.length, total),
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages || loading}
              >
                {t('llm_request_logs.pagination_next')}
              </Button>
            </div>
          </>
        )}
      </Card>

      <Modal
        open={Boolean(detailEntry)}
        onClose={() => setDetailEntry(null)}
        title={t('llm_request_logs.detail_title')}
        width={760}
      >
        <pre className={styles.detail}>
          {detailEntry ? JSON.stringify(detailEntry, null, 2) : ''}
        </pre>
      </Modal>
    </div>
  );
}
