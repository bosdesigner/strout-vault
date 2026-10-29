// Due dates said out loud: "Friday", "by end of week", "tomorrow", "in two weeks", "the 15th",
// "Nov 3". Resolved against the moment they were said (the recording's date, or the message's own
// time in a text or email thread), in Ben's time zone, so "Friday" on a Tuesday call is that
// week's Friday. The model is asked for the phrase verbatim; this turns it into a date. Anything
// vague ("soon", "next month", "ASAP") stays null rather than becoming a made-up deadline.
//
// Conventions (also in docs/phase1-verification.md, judgment calls):
//   "Friday" / "by Friday" / "this Friday"   the next Friday on or after the day it was said
//   "next Friday"                            the Friday of the following Monday-to-Sunday week
//   "end of (the) week" / "EOW"              this week's Friday (next Friday when said on a weekend)
//   "next week"                              Friday of next week (a due-by date, not a start date)
//   "end of (the) month" / "EOM"             the month's last day
//   a date without a year                    this year, or next year when it would be over 60 days ago

export const DEFAULT_TIMEZONE = "America/Chicago";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, "a couple of": 2, few: 3 };

/** A calendar day as UTC midnight, so arithmetic never crosses a DST edge. */
type Day = Date;

/** The calendar day `at` falls on in `timeZone`. */
export function localDay(at: Date, timeZone = DEFAULT_TIMEZONE): Day {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

const addDays = (d: Day, n: number): Day => new Date(d.getTime() + n * 86_400_000);
const ymd = (d: Day) => d.toISOString().slice(0, 10);

function weekdayIndex(word: string): number {
  const w = word.toLowerCase().slice(0, 3);
  return WEEKDAYS.findIndex((d) => d.startsWith(w));
}

/** The next `dow` on or after `from` (0 = Sunday). */
function onOrAfter(from: Day, dow: number): Day {
  return addDays(from, (dow - from.getUTCDay() + 7) % 7);
}

/** Monday of the week `d` is in (weeks run Monday to Sunday). */
function mondayOf(d: Day): Day {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

function validDay(y: number, m: number, day: number): Day | null {
  const d = new Date(Date.UTC(y, m, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === m && d.getUTCDate() === day ? d : null;
}

/** A month/day without a year: this year, or next year when that would be over 60 days in the past. */
function nearestYear(anchor: Day, m: number, day: number, year?: number): Day | null {
  if (year !== undefined) return validDay(year < 100 ? 2000 + year : year, m, day);
  const y = anchor.getUTCFullYear();
  const d = validDay(y, m, day);
  if (!d) return validDay(y + 1, m, day);
  return d.getTime() < addDays(anchor, -60).getTime() ? validDay(y + 1, m, day) : d;
}

function count(word: string): number | null {
  const w = word.trim().toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
}

/**
 * Resolves a spoken due date against the moment it was said. Returns YYYY-MM-DD, or null when
 * the phrase names no specific day.
 */
export function resolveDueDate(phrase: string | null | undefined, saidAt: Date, timeZone = DEFAULT_TIMEZONE): string | null {
  if (!phrase || Number.isNaN(saidAt.getTime())) return null;
  const p = phrase
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\b(by|before|on|until|no later than|due|for|at the latest|latest|around|sometime)\b/g, " ")
    .replace(/[,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!p) return null;
  const today = localDay(saidAt, timeZone);

  // An ISO date the model already resolved.
  let m = p.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const d = validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d ? ymd(d) : null;
  }
  if (/\b(today|tonight|this (morning|afternoon|evening)|end of (the )?day|eod|close of business|cob)\b/.test(p)) return ymd(today);
  if (/\b(tomorrow|tmrw|tmr)\b/.test(p)) return ymd(addDays(today, /\bday after tomorrow\b/.test(p) ? 2 : 1));
  if (/\b(end of (the |this )?week|eow)\b/.test(p)) {
    const fri = onOrAfter(today, 5);
    return ymd(today.getUTCDay() === 6 || today.getUTCDay() === 0 ? onOrAfter(addDays(today, 1), 5) : fri);
  }
  const namesWeekday = new RegExp(`\\b${WEEKDAY_RE}\\b`).test(p);
  if (/\bend of next week\b/.test(p) || (/\bnext week\b/.test(p) && !namesWeekday)) return ymd(addDays(mondayOf(today), 7 + 4));
  if (/\b(end of (the |this )?month|eom)\b/.test(p)) return ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)));
  if (/\b(end of next month)\b/.test(p)) return ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0)));

  // "in 3 days", "in two weeks", "a week from today", "10 days from now".
  m = p.match(/\b(?:in|within)\s+(\d+|a couple of|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few)\s+(business days?|days?|weeks?)\b/) ?? p.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(business days?|days?|weeks?)\s+from\s+(?:now|today)\b/);
  if (m) {
    const n = count(m[1]);
    if (n === null) return null;
    if (m[2].startsWith("business")) {
      let d = today;
      for (let left = n; left > 0; ) {
        d = addDays(d, 1);
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
      }
      return ymd(d);
    }
    return ymd(addDays(today, m[2].startsWith("week") ? n * 7 : n));
  }

  // Month names: "nov 3", "november 3rd", "3 november", "nov. 3, 2026".
  m = p.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`));
  if (m) {
    const d = nearestYear(today, MONTHS.indexOf(m[1].slice(0, 3)), Number(m[2]), m[3] ? Number(m[3]) : undefined);
    return d ? ymd(d) : null;
  }
  m = p.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:\\s+(\\d{4}))?\\b`));
  if (m) {
    const d = nearestYear(today, MONTHS.indexOf(m[2].slice(0, 3)), Number(m[1]), m[3] ? Number(m[3]) : undefined);
    return d ? ymd(d) : null;
  }
  // US numeric: 11/3, 11/3/26, 11/03/2026.
  m = p.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/);
  if (m) {
    const d = nearestYear(today, Number(m[1]) - 1, Number(m[2]), m[3] ? Number(m[3]) : undefined);
    return d ? ymd(d) : null;
  }

  // Weekdays: "friday", "this friday", "next friday", "friday next week", "monday morning".
  m = p.match(new RegExp(`\\b(next\\s+|this\\s+(?:coming\\s+)?|coming\\s+)?${WEEKDAY_RE}\\b(\\s+next week)?`));
  if (m) {
    const dow = weekdayIndex(m[2]);
    if (dow < 0) return null;
    if ((m[1] && m[1].startsWith("next")) || m[3]) return ymd(addDays(mondayOf(today), 7 + ((dow + 6) % 7)));
    return ymd(onOrAfter(today, dow));
  }

  // "the 15th" (a day of the month on its own): the next one on or after today.
  m = p.match(/\b(?:the\s+)?(\d{1,2})(st|nd|rd|th)\b/);
  if (m) {
    const day = Number(m[1]);
    for (let k = 0; k < 3; k++) {
      const d = validDay(today.getUTCFullYear(), today.getUTCMonth() + k, day);
      if (d && d.getTime() >= today.getTime()) return ymd(d);
    }
    return null;
  }
  return null;
}
