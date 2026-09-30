/**
 * 配置相关 API
 */

import { apiClient } from './client';
import type { Config } from '@/types';
import { normalizeConfigResponse } from './transformers';

export const configApi = {
  /**
   * 获取配置（会进行字段规范化）
   */
  async getConfig(): Promise<Config> {
    const raw = await apiClient.get('/config');
    return normalizeConfigResponse(raw);
  },

  /**
   * 请求日志开关
   */
  updateRequestLog: (enabled: boolean) => apiClient.put('/request-log', { value: enabled }),

  getGrok47Accounts: () => apiClient.get<{ value?: string }>('/xai/grok-4-7-accounts'),

  updateGrok47Accounts: (value: string) =>
    apiClient.put('/xai/grok-4-7-accounts', { value }),
};
