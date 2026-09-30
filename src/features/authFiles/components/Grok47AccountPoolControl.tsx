import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { configApi } from '@/services/api/config';
import styles from './Grok47AccountPoolControl.module.scss';

const GROK47_ACCOUNT_MODES = ['outlook-clean', 'outlook-all', 'non-outlook', 'all'] as const;

type Grok47AccountMode = (typeof GROK47_ACCOUNT_MODES)[number];

const isGrok47AccountMode = (value: string): value is Grok47AccountMode =>
  GROK47_ACCOUNT_MODES.includes(value as Grok47AccountMode);

const modeLabelKey = (mode: Grok47AccountMode) =>
  `auth_files.grok47_accounts_${mode.replace(/-/g, '_')}`;

export function Grok47AccountPoolControl() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Grok47AccountMode>('outlook-clean');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'load' | 'save' | null>(null);

  useEffect(() => {
    let cancelled = false;
    void configApi
      .getGrok47Accounts()
      .then((data) => {
        if (cancelled) return;
        const value = typeof data?.value === 'string' ? data.value : '';
        setMode(isGrok47AccountMode(value) ? value : 'outlook-clean');
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError('load');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = (value: string) => {
    if (!isGrok47AccountMode(value) || value === mode || saving) return;
    const previous = mode;
    setMode(value);
    setSaving(true);
    setError(null);
    void configApi
      .updateGrok47Accounts(value)
      .then(() => {
        setSaving(false);
      })
      .catch(() => {
        setMode(previous);
        setError('save');
        setSaving(false);
      });
  };

  const message =
    error === 'load'
      ? t('auth_files.grok47_accounts_load_failed')
      : error === 'save'
        ? t('auth_files.grok47_accounts_save_failed')
        : t('auth_files.grok47_accounts_hint');

  return (
    <div className={styles.bar}>
      <label className={styles.label} htmlFor="grok47-accounts">
        {t('auth_files.grok47_accounts_label')}
      </label>
      <div className={styles.select}>
        <Select
          id="grok47-accounts"
          value={mode}
          options={GROK47_ACCOUNT_MODES.map((value) => ({
            value,
            label: t(modeLabelKey(value)),
          }))}
          onChange={onChange}
          disabled={loading || saving}
          ariaLabel={t('auth_files.grok47_accounts_label')}
          fullWidth
          size="sm"
        />
      </div>
      <p className={error ? styles.error : styles.hint}>{message}</p>
    </div>
  );
}