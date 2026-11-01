import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMaterialId } from '../../packages/@openmaic/storage/src/material/types';

describe('material ID browser boundary', () => {
  it('keeps the published prefix, encoding and all 128 random bits using Web Crypto', () => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      const values = Array.from({ length: 100 }, () => createMaterialId());
      expect(values.every((value) => /^mat_[0-9a-hjkmnp-tv-z]{26}$/.test(value))).toBe(true);
      expect(new Set(values).size).toBe(100);
      expect(random).toHaveBeenCalledTimes(100);
      expect(random.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
      expect(random.mock.calls[0][0]?.byteLength).toBe(16);
    } finally {
      random.mockRestore();
    }
  });

  it('does not import a Node builtin from the shared public material types entry', () => {
    const source = readFileSync('packages/@openmaic/storage/src/material/types.ts', 'utf8');
    expect(source).not.toMatch(/from\s+['"](?:node:)?crypto['"]/);
  });
});
