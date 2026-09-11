// A five-field cron parser, written here rather than depended on.
//
// The relay has exactly one dependency (pglite) and this is ~100 lines of
// arithmetic; a cron library would be the second, for something whose entire
// surface is "which minutes match".
//
//   ┌ minute (0-59)
//   │ ┌ hour (0-23)
//   │ │ ┌ day of month (1-31)
//   │ │ │ ┌ month (1-12)
//   │ │ │ │ ┌ day of week (0-6, Sunday = 0; 7 also means Sunday)
//   * * * * *
//
// Each field takes `*`, a number, `a-b`, `a-b/n`, `*/n`, and comma lists of
// those. Names are not accepted (JAN, MON): one spelling of a thing beats two.
//
// Timezones are real, and they are why this walks a CALENDAR rather than
// adding milliseconds. "Every night at 2am" in America/New_York is 23 hours
// after the previous one on the day the clocks go forward, and 25 on the day
// they go back; anything that steps by a fixed 86_400_000 drifts an hour twice
// a year and is wrong for a fortnight until someone notices.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 },
];

export class CronError extends Error {}

/** One field to the set of values it matches. */
function parseField(raw, { name, min, max }) {
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const piece = part.trim();
    if (!piece) throw new CronError(`empty ${name} field`);
    const [spec, stepRaw] = piece.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step in ${name}: ${piece}`);

    let lo, hi;
    if (spec === '*') { lo = min; hi = max; }
    else if (spec.includes('-')) {
      const [a, b] = spec.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new CronError(`bad range in ${name}: ${piece}`);
      lo = a; hi = b;
    } else {
      const n = Number(spec);
      if (!Number.isInteger(n)) throw new CronError(`bad value in ${name}: ${piece}`);
      lo = n; hi = n;
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`${name} out of range: ${piece}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('a cron expression has five fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  // 7 and 0 are both Sunday, which is the one piece of cron folklore worth
  // honouring: expressions written elsewhere use both.
  if (dow.has(7)) dow.add(0);
  return {
    minute, hour, dom, month, dow,
    /** Vixie cron's rule: with BOTH day fields restricted, a day matching
     *  EITHER fires. `0 0 1 * 1` is the first of the month AND every Monday,
     *  not their intersection — surprising, but it is what every other cron
     *  does, and an automation copied from a crontab must behave the same. */
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/** The wall-clock fields of `ms` in `timeZone`. */
function wallClock(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // 24:00 is midnight next day in some locales
    minute: Number(parts.minute),
    dow: DAYS[parts.weekday],
  };
}

/** A wall-clock minute, as an identity. Two instants with the same key are
 *  the same occurrence of a schedule even when an hour of offset separates
 *  them (see the autumn boundary in nextCronAfter). */
function wallClockKey(wc) {
  return `${wc.year}-${wc.month}-${wc.day}T${wc.hour}:${wc.minute}`;
}

function dayMatches(cron, wc) {
  const dom = cron.dom.has(wc.day);
  const dow = cron.dow.has(wc.dow);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}

/** How far ahead to look before giving up. Four years covers Feb 29 with a
 *  leap-year margin; an expression that matches nothing in four years matches
 *  nothing, and saying so beats spinning. */
const HORIZON_MS = 4 * 366 * 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

/**
 * The first minute strictly after `fromMs` that matches, or null.
 *
 * Walks minute by minute, but skips a whole day at a time when the date
 * cannot match — so the worst realistic case (`0 0 29 2 *`, Feb 29) is a few
 * thousand iterations, not a few million.
 */
export function nextCronAfter(expr, timeZone, fromMs) {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr;
  const tz = timeZone || 'UTC';
  // The wall clock we are coming FROM. On the autumn day the clocks go back,
  // 01:30 local happens twice — 05:30Z and 06:30Z — and a daily schedule that
  // simply took the next matching instant fired TWICE that day. A schedule is
  // defined in wall-clock terms, so the same wall-clock minute is the same
  // occurrence however many times the offset makes it come round.
  const fromWall = wallClockKey(wallClock(fromMs, tz));
  // Start at the next whole minute: a schedule fires at most once a minute,
  // and `fromMs` is usually the previous fire.
  let t = Math.floor(fromMs / MINUTE) * MINUTE + MINUTE;
  const limit = fromMs + HORIZON_MS;
  while (t <= limit) {
    const wc = wallClock(t, tz);
    if (!cron.month.has(wc.month) || !dayMatches(cron, wc)) {
      // Jump to the start of the next day IN THIS ZONE, rather than adding 24h
      // — across a DST boundary a fixed day is 23 or 25 hours.
      const minutesLeftToday = (23 - wc.hour) * 60 + (60 - wc.minute);
      t += minutesLeftToday * MINUTE;
      continue;
    }
    if (!cron.hour.has(wc.hour)) { t += (60 - wc.minute) * MINUTE; continue; }
    if (!cron.minute.has(wc.minute)) { t += MINUTE; continue; }
    if (wallClockKey(wc) === fromWall) { t += MINUTE; continue; } // the repeated hour
    return t;
  }
  return null;
}

/**
 * Every occurrence in (fromMs, toMs], capped.
 *
 * This exists for the catch-up decision, which is the whole reason a
 * scheduler is more awkward than a trigger: a machine offline for a week owes
 * 2,016 five-minute firings when it returns. Joy fires ONCE and records the
 * rest as skipped, so the history says what happened instead of either
 * stampeding or silently forgetting.
 */
export function cronOccurrencesBetween(expr, timeZone, fromMs, toMs, cap = 1000) {
  const cron = parseCron(typeof expr === 'string' ? expr : String(expr));
  const out = [];
  let t = fromMs;
  while (out.length < cap) {
    const next = nextCronAfter(cron, timeZone, t);
    if (next === null || next > toMs) break;
    out.push(next);
    t = next;
  }
  return out;
}
