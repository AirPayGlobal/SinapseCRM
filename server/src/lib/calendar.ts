/**
 * Service calendar arithmetic. Response targets are measured in business minutes against a
 * calendar that honours configured business hours and Namibian public holidays, so a weekend
 * or a holiday does not consume a response target (WM-01.5).
 */

export interface ServiceCalendar {
  utcOffsetMinutes: number; // Namibia: +120 (CAT, no daylight saving)
  /** weekday "0" (Sunday) .. "6" → list of ["HH:MM","HH:MM"] intervals */
  businessHours: Record<string, [string, string][]>;
  holidays: Set<string>; // YYYY-MM-DD in local time
}

const MIN = 60_000;
const DAY_MIN = 24 * 60;

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Local day key and minute-of-day for an instant. */
function local(cal: ServiceCalendar, t: number) {
  const d = new Date(t + cal.utcOffsetMinutes * MIN);
  const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { key, weekday: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60, dayStartUtc: t - (d.getUTCHours() * 60 + d.getUTCMinutes()) * MIN - d.getUTCSeconds() * 1000 - d.getUTCMilliseconds() };
}

function intervalsFor(cal: ServiceCalendar, key: string, weekday: number): [number, number][] {
  if (cal.holidays.has(key)) return [];
  return (cal.businessHours[String(weekday)] ?? []).map(([s, e]) => [toMinutes(s), toMinutes(e)] as [number, number]);
}

/** Instant that is `minutes` business minutes after `start`. */
export function addBusinessMinutes(cal: ServiceCalendar, start: Date, minutes: number): Date {
  let remaining = Math.max(0, minutes);
  let t = start.getTime();
  for (let guard = 0; guard < 3660; guard++) {
    const { key, weekday, minute, dayStartUtc } = local(cal, t);
    for (const [s, e] of intervalsFor(cal, key, weekday)) {
      if (minute >= e) continue;
      const from = Math.max(minute, s);
      const avail = e - from;
      if (remaining <= avail) return new Date(dayStartUtc + (from + remaining) * MIN);
      remaining -= avail;
    }
    t = dayStartUtc + DAY_MIN * MIN; // next local midnight
  }
  throw new Error('calendar has no business hours');
}

/** Business minutes elapsed between two instants (0 if b <= a). */
export function businessMinutesBetween(cal: ServiceCalendar, a: Date, b: Date): number {
  let t = a.getTime();
  const end = b.getTime();
  if (end <= t) return 0;
  let total = 0;
  for (let guard = 0; guard < 3660 && t < end; guard++) {
    const { key, weekday, minute, dayStartUtc } = local(cal, t);
    const endMinute = Math.min(DAY_MIN, (end - dayStartUtc) / MIN);
    for (const [s, e] of intervalsFor(cal, key, weekday)) {
      const from = Math.max(minute, s);
      const to = Math.min(e, endMinute);
      if (to > from) total += to - from;
    }
    t = dayStartUtc + DAY_MIN * MIN;
  }
  return Math.round(total);
}

export function isBusinessTime(cal: ServiceCalendar, at: Date, pattern?: Record<string, [string, string][]> | null): boolean {
  const { key, weekday, minute } = local(cal, at.getTime());
  const source: ServiceCalendar = pattern ? { ...cal, businessHours: pattern } : cal;
  return intervalsFor(source, key, weekday).some(([s, e]) => minute >= s && minute < e);
}

// ---------------------------------------------------------------------------
// Namibian public holidays (Public Holidays Act 26 of 1990, as amended).
// When a holiday falls on a Sunday, the following Monday is a public holiday.
// ---------------------------------------------------------------------------

function easterSunday(year: number): Date {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export function namibianPublicHolidays(year: number): { day: string; name: string }[] {
  const fixed: [number, number, string][] = [
    [1, 1, "New Year's Day"],
    [3, 21, 'Independence Day'],
    [5, 1, "Workers' Day"],
    [5, 4, 'Cassinga Day'],
    [5, 25, 'Africa Day'],
    [5, 28, 'Genocide Remembrance Day'],
    [8, 26, "Heroes' Day"],
    [12, 10, 'Day of the Namibian Women and International Human Rights Day'],
    [12, 25, 'Christmas Day'],
    [12, 26, 'Family Day'],
  ];
  const out: { day: string; name: string }[] = [];
  const taken = new Set<string>();
  const push = (d: Date, name: string) => {
    out.push({ day: iso(d), name });
    taken.add(iso(d));
  };
  const easter = easterSunday(year);
  push(addDays(easter, -2), 'Good Friday');
  push(addDays(easter, 1), 'Easter Monday');
  push(addDays(easter, 39), 'Ascension Day');
  for (const [m, d, name] of fixed) push(new Date(Date.UTC(year, m - 1, d)), name);
  // Sunday rule
  for (const h of [...out]) {
    const d = new Date(h.day + 'T00:00:00Z');
    if (d.getUTCDay() === 0) {
      let next = addDays(d, 1);
      while (taken.has(iso(next))) next = addDays(next, 1);
      push(next, `${h.name} (observed)`);
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}
