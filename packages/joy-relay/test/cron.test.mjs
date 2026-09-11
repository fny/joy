import { describe, it, expect } from 'vitest';
import { parseCron, nextCronAfter, cronOccurrencesBetween, CronError } from '../src/cron.mjs';

/** A readable wall-clock string in a zone, for asserting what actually fires. */
const at = (ms, tz = 'UTC') =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms)).replace(',', '');

const utc = (s) => Date.parse(s);

describe('parseCron', () => {
  it('takes the field forms cron takes', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9-17 * * *').hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron('0 0 * * 1-5/2').dow]).toEqual([1, 3, 5]);
    expect([...parseCron('0,30 * * * *').minute]).toEqual([0, 30]);
  });

  it('treats 7 as Sunday, because expressions copied from a crontab do', () => {
    expect(parseCron('0 0 * * 7').dow.has(0)).toBe(true);
  });

  it('refuses what it cannot honour, by name, instead of silently matching nothing', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '0 0 32 * *', '0 0 * 13 *', '*/0 * * * *', 'a * * * *', '5-1 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
  });

  it('does not accept names — one spelling of a thing beats two', () => {
    expect(() => parseCron('0 0 * JAN *')).toThrow(CronError);
    expect(() => parseCron('0 0 * * MON')).toThrow(CronError);
  });
});

describe('nextCronAfter', () => {
  it('finds the next matching minute, exclusive of now', () => {
    const from = utc('2026-03-10T01:59:00Z');
    expect(at(nextCronAfter('0 2 * * *', 'UTC', from))).toBe('10/03/2026 02:00');
    // Exactly on a match returns the NEXT one, never the same minute twice.
    expect(at(nextCronAfter('0 2 * * *', 'UTC', utc('2026-03-10T02:00:00Z')))).toBe('11/03/2026 02:00');
  });

  it('every fifteen minutes means every fifteen minutes', () => {
    let t = utc('2026-03-10T09:02:00Z');
    const seen = [];
    for (let i = 0; i < 4; i++) { t = nextCronAfter('*/15 * * * *', 'UTC', t); seen.push(at(t)); }
    expect(seen).toEqual(['10/03/2026 09:15', '10/03/2026 09:30', '10/03/2026 09:45', '10/03/2026 10:00']);
  });

  it('weekday-only skips the weekend', () => {
    // 2026-03-13 is a Friday.
    const friday9 = utc('2026-03-13T09:00:00Z');
    expect(at(nextCronAfter('0 9 * * 1-5', 'UTC', friday9))).toBe('16/03/2026 09:00'); // Monday
  });

  describe('timezones, which are the reason this walks a calendar', () => {
    it('fires at LOCAL 2am, not at a fixed offset from UTC', () => {
      const tz = 'America/New_York';
      // Winter: EST, UTC-5 → 07:00Z.
      expect(at(nextCronAfter('0 2 * * *', tz, utc('2026-01-15T00:00:00Z')), 'UTC')).toBe('15/01/2026 07:00');
      // Summer: EDT, UTC-4 → 06:00Z. A scheduler that added 86_400_000 would
      // now be an hour wrong, twice a year, until somebody noticed.
      expect(at(nextCronAfter('0 2 * * *', tz, utc('2026-07-15T00:00:00Z')), 'UTC')).toBe('15/07/2026 06:00');
    });

    it('skips an hour that does not exist, and does not stall afterwards', () => {
      const tz = 'America/New_York';
      // 2026-03-08 is the US spring-forward: the clock jumps 02:00 → 03:00, so
      // 02:30 local exists on the 7th and the 9th but NOT on the 8th. (01:30
      // does exist on all three — the vanished hour is 02:00-02:59, which is
      // the kind of detail worth a test rather than a memory.)
      let t = utc('2026-03-07T00:00:00Z');
      const fires = [];
      for (let i = 0; i < 3; i++) { t = nextCronAfter('30 2 * * *', tz, t); fires.push(at(t, tz)); }
      // The 8th is missing — that minute is not on the clock there — and,
      // crucially, the schedule picks up again rather than drifting or stopping.
      expect(fires).toEqual(['07/03/2026 02:30', '09/03/2026 02:30', '10/03/2026 02:30']);
    });

    it('fires ONCE on the autumn day when the hour happens twice', () => {
      const tz = 'America/New_York';
      // 2026-11-01: 01:30 local occurs twice, at 05:30Z and 06:30Z. A daily
      // schedule must not fire twice that day just because the clock repeats.
      let t = utc('2026-10-31T00:00:00Z');
      const fires = [];
      for (let i = 0; i < 3; i++) { t = nextCronAfter('30 1 * * *', tz, t); fires.push(at(t, tz)); }
      expect(fires).toEqual(['31/10/2026 01:30', '01/11/2026 01:30', '02/11/2026 01:30']);
    });

    it('is UTC when no zone is given', () => {
      expect(at(nextCronAfter('0 2 * * *', null, utc('2026-01-15T00:00:00Z')), 'UTC')).toBe('15/01/2026 02:00');
    });
  });

  it('honours the both-day-fields rule every other cron uses', () => {
    // With BOTH restricted, a day matching EITHER fires — Vixie's rule. An
    // expression copied from a crontab has to behave the same here.
    const from = utc('2026-06-01T12:00:00Z'); // Monday 1 June
    const next = nextCronAfter('0 0 15 * 3', 'UTC', from); // 15th OR Wednesday
    expect(at(next)).toBe('03/06/2026 00:00'); // the Wednesday, not the 15th
  });

  it('finds a leap day without walking a million minutes', () => {
    const started = Date.now();
    const next = nextCronAfter('0 0 29 2 *', 'UTC', utc('2026-03-01T00:00:00Z'));
    expect(at(next)).toBe('29/02/2028 00:00');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns null rather than spinning on an expression that can never match', () => {
    expect(nextCronAfter('0 0 30 2 *', 'UTC', Date.now())).toBeNull(); // 30 February
  });
});

describe('cronOccurrencesBetween — the catch-up question', () => {
  it('counts what was missed while a machine was away', () => {
    // This is the whole reason a scheduler is more awkward than a trigger: a
    // machine offline for a day owes 288 five-minute firings when it returns.
    const from = utc('2026-03-10T00:00:00Z');
    const to = utc('2026-03-11T00:00:00Z');
    expect(cronOccurrencesBetween('*/5 * * * *', 'UTC', from, to)).toHaveLength(288);
  });

  it('is capped, so a week offline cannot allocate a stampede', () => {
    const from = utc('2026-03-01T00:00:00Z');
    const to = utc('2026-03-08T00:00:00Z');
    expect(cronOccurrencesBetween('* * * * *', 'UTC', from, to, 50)).toHaveLength(50);
  });

  it('is empty when nothing was missed', () => {
    const t = utc('2026-03-10T02:00:00Z');
    expect(cronOccurrencesBetween('0 2 * * *', 'UTC', t, t + 60_000)).toEqual([]);
  });
});
