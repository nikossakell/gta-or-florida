/** Build-time rule for the Daily Drive redesign (approved: on by default, `0` rolls back). */
import { describe, expect, it } from 'vitest';
import { dailyDriveOn } from '../vite.config.ts';

describe('dailyDriveOn', () => {
  it('is on by default for dev and the Cloudflare Pages build', () => {
    expect(dailyDriveOn(undefined, 'development')).toBe(true);
    expect(dailyDriveOn(undefined, 'production')).toBe(true);
    expect(dailyDriveOn('', 'production')).toBe(true);
  });
  it('stays off by default in tests and in the legacy static demo build', () => {
    expect(dailyDriveOn(undefined, 'test')).toBe(false);
    expect(dailyDriveOn(undefined, 'pages')).toBe(false);
  });
  it('an explicit value always wins (0 = rollback)', () => {
    expect(dailyDriveOn('0', 'production')).toBe(false);
    expect(dailyDriveOn('1', 'pages')).toBe(true);
    expect(dailyDriveOn('1', 'test')).toBe(true);
  });
});
