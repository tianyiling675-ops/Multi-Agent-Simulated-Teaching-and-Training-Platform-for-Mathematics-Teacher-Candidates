import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

describe('DEFAULT_BRAND (single-brand build)', () => {
  it('uses the teaching simulation system identity for full chrome', () => {
    expect(DEFAULT_BRAND.productName).toBe('多智能体课堂模拟与教学评测系统');
    expect(DEFAULT_BRAND.shortName).toBe('多智能体课堂模拟与教学评测系统');
    expect(DEFAULT_BRAND.markSrc).toBe('/openmaic-mark.png');
    expect(DEFAULT_BRAND.themeColor).toBe('#722ed1');
  });

  it('marks its horizontal logo as already containing the wordmark', () => {
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(true);
    expect(DEFAULT_BRAND.logoSrc).toBe('/system-logo.svg');
  });
});
