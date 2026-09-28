// Toronto wall-clock helpers. No external deps: DST is computed with the
// North-America rule (second Sunday of March -> first Sunday of November).

export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

export function isValidTimeStr(s: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function nthSundayOfMonth(year: number, monthIndex: number, n: number): number {
  // day-of-month of the nth Sunday (monthIndex 0-based)
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstDow = first.getUTCDay(); // 0=Sun
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/** True when Toronto observes EDT (UTC-4) on the given YYYY-MM-DD. */
export function isTorontoDST(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  // DST starts 2nd Sunday of March, ends 1st Sunday of November.
  const start = nthSundayOfMonth(y, 2, 2);
  const end = nthSundayOfMonth(y, 10, 1);
  if (m > 3 && m < 11) return true;
  if (m < 3 || m > 11) return false;
  if (m === 3) return d >= start;
  return d < end; // m === 11
}

export function torontoOffset(dateStr: string): string {
  return isTorontoDST(dateStr) ? "-04:00" : "-05:00";
}

/** Toronto weekday (0=Sun..6=Sat) for a YYYY-MM-DD date. */
export function torontoWeekday(dateStr: string): number {
  // Noon Toronto is unambiguous for weekday even across DST transitions.
  const probe = new Date(`${dateStr}T12:00:00${torontoOffset(dateStr)}`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    weekday: "short",
  });
  const short = fmt.format(probe);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[short] ?? -1;
}

/** Today's date in Toronto as YYYY-MM-DD. */
export function torontoToday(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA yields YYYY-MM-DD
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** ISO timestamp for a Toronto wall-clock time: dateStr + minutes from midnight. */
export function torontoISO(dateStr: string, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(min).padStart(2, "0");
  return `${dateStr}T${hh}:${mm}:00${torontoOffset(dateStr)}`;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function plusMsISO(ms: number, from: number = Date.now()): string {
  return new Date(from + ms).toISOString();
}

/** Next Toronto open day (Tue-Sat) strictly after `fromDateStr`, + offset open days. */
export function nextOpenDateStr(
  fromDateStr: string,
  offsetOpenDays: number,
  closedWeekdays: readonly number[],
): string {
  let date = addDays(fromDateStr, 1);
  let seen = 0;
  for (let i = 0; i < 60; i++) {
    if (!closedWeekdays.includes(torontoWeekday(date))) {
      if (seen === offsetOpenDays) return date;
      seen++;
    }
    date = addDays(date, 1);
  }
  throw new Error("could not find open day within 60 days");
}
