import { describe, expect, test } from 'bun:test';
import { isDownrankAuthFile } from '../src/features/authFiles/constants';
import type { AuthFileItem } from '../src/types';

const authFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'credential.json',
  type: 'xai',
  ...overrides,
});

describe('auth file downrank mark', () => {
  test('reads the normalized camelCase flag', () => {
    expect(isDownrankAuthFile(authFile({ xaiDownrankPool: true }))).toBe(true);
  });

  test('reads the raw backend flag', () => {
    expect(isDownrankAuthFile(authFile({ xai_downrank_pool: true }))).toBe(true);
    expect(isDownrankAuthFile(authFile({ xai_downrank_pool: 'true' }))).toBe(true);
    expect(isDownrankAuthFile(authFile({ xai_downrank_pool: 1 }))).toBe(true);
  });

  test('ignores unmarked credentials', () => {
    expect(isDownrankAuthFile(authFile())).toBe(false);
    expect(isDownrankAuthFile(authFile({ xaiDownrankPool: false }))).toBe(false);
    expect(isDownrankAuthFile(authFile({ xai_downrank_pool: false }))).toBe(false);
  });
});
