import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate, installUpdate, parseVersionFile, registerUpdater, useUpdate, type UpdateInfo } from './updates.ts';
import { renderHook, act } from '@testing-library/react';

const BASE = 'https://github.com/someone/earworm/releases/download/android-latest';
const SHA = 'a'.repeat(64);
const file = { versionCode: 42, versionName: '1.0.42', apk: 'earworm.apk', sha256: SHA, size: 4_400_000 };

describe('parseVersionFile', () => {
  it('offers a newer build', () => {
    expect(parseVersionFile(file, 41, BASE)).toEqual({
      versionCode: 42,
      versionName: '1.0.42',
      apkUrl: `${BASE}/earworm.apk`,
      sha256: SHA,
      size: 4_400_000,
    });
  });

  it('stays quiet when you already have it (or something newer)', () => {
    expect(parseVersionFile(file, 42, BASE)).toBeNull();
    expect(parseVersionFile(file, 50, BASE)).toBeNull();
  });

  it('refuses broken or suspicious files', () => {
    for (const bad of [null, {}, { ...file, sha256: 'nope' }, { ...file, apk: '../evil.apk' }, { ...file, versionCode: '43' }]) {
      expect(() => parseVersionFile(bad, 1, BASE)).toThrow('broken');
    }
  });
});

describe('updating', () => {
  const update: UpdateInfo = { versionCode: 42, versionName: '1.0.42', apkUrl: `${BASE}/earworm.apk`, sha256: SHA, size: 4_400_000 };

  it('goes from checking to installing', async () => {
    const install = vi.fn(async () => {});
    registerUpdater({ currentVersion: '1.0.41', check: async () => update, install });
    const { result } = renderHook(() => useUpdate());
    expect(result.current).toEqual({ status: 'idle', current: '1.0.41' });

    await act(() => checkForUpdate());
    expect(result.current).toEqual({ status: 'available', current: '1.0.41', update });

    await act(() => installUpdate());
    expect(install).toHaveBeenCalledWith(update);
    // You can back out of Android's installer, so the update stays on offer.
    expect(result.current.status).toBe('available');
  });

  it('reports problems when you asked, but not from the start-up check', async () => {
    registerUpdater({
      currentVersion: '1.0.41',
      check: async () => Promise.reject(new Error('Couldn’t check for updates (404)')),
      install: async () => {},
    });
    const { result } = renderHook(() => useUpdate());
    await act(() => checkForUpdate({ quiet: true }));
    expect(result.current).toEqual({ status: 'idle', current: '1.0.41' });
    await act(() => checkForUpdate());
    expect(result.current).toMatchObject({ status: 'error', message: 'Couldn’t check for updates (404)' });
  });

  it('says so when you are up to date, and explains a failed download', async () => {
    let latest: UpdateInfo | null = null;
    registerUpdater({
      currentVersion: '1.0.41',
      check: async () => latest,
      install: async () => Promise.reject(new Error('The download was damaged. Please try again.')),
    });
    const { result } = renderHook(() => useUpdate());
    await act(() => checkForUpdate());
    expect(result.current).toEqual({ status: 'current', current: '1.0.41' });

    latest = update;
    await act(() => checkForUpdate());
    await act(() => installUpdate());
    expect(result.current).toMatchObject({ status: 'error', message: 'The download was damaged. Please try again.', update });
  });
});
