import { describe, expect, it } from 'vitest';
import { buildSessions } from '../src/core/sessions';
import type { Heartbeat } from '../src/core/types';

const MIN = 60_000;
const base = new Date(2026, 9, 13, 9, 0).getTime();
const hb = (min: number, key: string | null = 'PAY-1', extra: Partial<Heartbeat> = {}): Heartbeat => ({
  t: base + min * MIN,
  repo: 'api',
  branch: key ? `feature/${key}` : 'main',
  key,
  signal: 'edit',
  ...extra,
});

describe('buildSessions', () => {
  it('sums gaps up to the idle threshold', () => {
    const sessions = buildSessions([hb(0), hb(5), hb(10), hb(20)], 15 * MIN);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].activeMs).toBe(20 * MIN);
  });

  it('ends a session after an idle gap', () => {
    const sessions = buildSessions([hb(0), hb(10), hb(40), hb(50)], 15 * MIN);
    expect(sessions.map((s) => s.activeMs)).toEqual([10 * MIN, 10 * MIN]);
  });

  it('gives the gap before a switch to the previous issue', () => {
    const sessions = buildSessions([hb(0), hb(10), hb(12, 'PAY-2'), hb(25, 'PAY-2')], 15 * MIN);
    expect(sessions.map((s) => [s.key, s.activeMs])).toEqual([
      ['PAY-1', 12 * MIN],
      ['PAY-2', 13 * MIN],
    ]);
  });

  it('accepts unsorted input', () => {
    const sessions = buildSessions([hb(10), hb(0), hb(5)], 15 * MIN);
    expect(sessions[0].activeMs).toBe(10 * MIN);
  });

  it('counts a short blur but caps a long one at the grace period', () => {
    const short = buildSessions([hb(0), hb(10, 'PAY-1', { signal: 'blur' }), hb(11), hb(20)], 15 * MIN, 2 * MIN);
    expect(short.map((s) => s.activeMs)).toEqual([20 * MIN]);

    const long = buildSessions([hb(0), hb(10, 'PAY-1', { signal: 'blur' }), hb(20), hb(25)], 15 * MIN, 2 * MIN);
    expect(long.map((s) => s.activeMs)).toEqual([12 * MIN, 5 * MIN]);
  });

  it('hands over cleanly between two windows', () => {
    const sessions = buildSessions(
      [hb(0), hb(10, 'PAY-1', { signal: 'blur' }), hb(10.5, 'WEB-3', { repo: 'web' }), hb(20, 'WEB-3', { repo: 'web' })],
      15 * MIN,
      2 * MIN,
    );
    expect(sessions.map((s) => [s.key, s.activeMs])).toEqual([
      ['PAY-1', 10.5 * MIN],
      ['WEB-3', 9.5 * MIN],
    ]);
  });

  it('drops lone heartbeats', () => {
    expect(buildSessions([hb(0)], 15 * MIN)).toEqual([]);
  });
});
