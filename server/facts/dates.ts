// Turns the way people say a due date ("Friday", "next Tuesday", "by end of week", "the 15th",
// "10/30") into a YYYY-MM-DD, counted from the day it was said in Ben's timezone. Pure, no database.
// The extractor asks Claude for the phrase as spoken (due_text) and resolves it here, so "Friday"
// in a Wednesday text means that week's Friday whatever the model guessed; when the phrase is not
// one of these shapes, the model's own YYYY-MM-DD (if any) is used.
import { LOCAL_TIMEZONE } from "../messages/ingest.ts";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The calendar day (y, m 1-12, d) an instant falls on in `tz`. */
export function localYmd(at: Date, tz = LOCAL_TIMEZONE): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function utcDay(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
function dayIndex(word: string): number | null {
  const w = word.toLowerCase().replace(/\./g, "");
  const full = DAYS.indexOf(w.replace(/s$/, ""));
  if (full >= 0) return full;
  return DAY_ABBR[w] ?? null;
}
function monthIndex(word: string): number | null {
  const w = word.toLowerCase().replace(/\./g, "");
  const i = MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
  return i >= 0 ? i + 1 : null;
}

/**
 * Resolves `phrase` against the day `said` falls on (America/Chicago). Returns null when the phrase
 * is not a date expression this understands, or when it resolves to a day before it was said.
 */
export function resolveDueDate(phrase: string | null | undefined, said: Date, tz = LOCAL_TIMEZONE): string | null {
  if (!phrase || Number.isNaN(said.getTime())) return null;
  const p = phrase
    .toLowerCase()
    .replace(/[,!?]/g, " ")
    .replace(/\b(by|before|on|until|no later than|due|at the latest|sometime|around|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!p) return null;
  const { y, m, d } = localYmd(said, tz);
  const today = utcDay(y, m, d);
  const dow = today.getUTCDay();
  const ok = (x: Date | null) => (x && x.getTime() >= today.getTime() ? fmt(x) : null);

  if (/^(today|tonight|this (evening|afternoon|morning)|eod|end of (the )?day)$/.test(p)) return fmt(today);
  if (/^(tomorrow|tmrw|tmr)( (morning|afternoon|evening|night))?$/.test(p)) return fmt(addDays(today, 1));
  if (/^(day after tomorrow)$/.test(p)) return fmt(addDays(today, 2));

  // "end of (the) week" / "eow" / "this week": Friday of this week (today when it is already Friday or later).
  if (/^(eow|end of( this)? week|this week)$/.test(p)) return fmt(addDays(today, Math.max(0, 5 - dow)));
  // Weeks run Monday to Sunday: "next week" is next Monday, "end of next week" that week's Friday.
  const nextMonday = addDays(today, (8 - dow) % 7 || 7);
  if (/^(next week)$/.test(p)) return fmt(nextMonday);
  if (/^(end of next week)$/.test(p)) return fmt(addDays(nextMonday, 4));
  if (/^(eom|end of( this| the)? month)$/.test(p)) return fmt(new Date(Date.UTC(y, m, 0)));
  if (/^(next month)$/.test(p)) return fmt(utcDay(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1));

  // "in 3 days", "in two weeks", "a week from today"
  const nums: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, couple: 2 };
  const inN = p.match(/^(?:in )?(\d+|a|an|one|two|three|four|five|six|seven|ten|couple)(?: of)? (day|days|week|weeks)(?: from (?:now|today))?$/);
  if (inN && (/^in /.test(p) || /from (now|today)/.test(p))) {
    const n = Number(inN[1]) || nums[inN[1]] || 1;
    return fmt(addDays(today, n * (inN[2].startsWith("week") ? 7 : 1)));
  }

  // Weekdays: "friday", "this friday", "next friday", "friday morning", "fri".
  const wd = p.match(/^(this |next |coming |this coming )?([a-z.]+)(?: (morning|afternoon|evening|night|eod))?$/);
  if (wd) {
    const idx = dayIndex(wd[2]);
    if (idx !== null) {
      // "next Friday" is the Friday of next week (Monday-Sunday weeks); a bare or "this" Friday is the
      // coming one, today included.
      if ((wd[1] ?? "").trim() === "next") return fmt(addDays(nextMonday, (idx + 6) % 7));
      return fmt(addDays(today, (idx - dow + 7) % 7));
    }
  }

  // Explicit dates: "10/30", "10/30/2026", "2026-10-30", "oct 30", "october 30th", "30 october", "the 15th".
  const iso = p.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return ok(utcDay(+iso[1], +iso[2], +iso[3]));
  const slash = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    const mm = +slash[1];
    const dd = +slash[2];
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    let yy = slash[3] ? +slash[3] : y;
    if (yy < 100) yy += 2000;
    let dt = utcDay(yy, mm, dd);
    if (!slash[3] && dt < today) dt = utcDay(yy + 1, mm, dd);
    return ok(dt);
  }
  const md = p.match(/^([a-z.]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/) ?? null;
  const dm = p.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z.]+)(?: (\d{4}))?$/) ?? null;
  const pair = md ? { mon: md[1], day: md[2], yr: md[3] } : dm ? { mon: dm[2], day: dm[1], yr: dm[3] } : null;
  if (pair) {
    const mi = monthIndex(pair.mon);
    if (mi) {
      let yy = pair.yr ? +pair.yr : y;
      let dt = utcDay(yy, mi, +pair.day);
      if (!pair.yr && dt < today) dt = utcDay(++yy, mi, +pair.day);
      return ok(dt);
    }
  }
  const nth = p.match(/^(\d{1,2})(?:st|nd|rd|th)$/);
  if (nth) {
    const dd = +nth[1];
    if (dd < 1 || dd > 31) return null;
    let dt = utcDay(y, m, dd);
    if (dt < today) dt = utcDay(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, dd);
    return ok(dt);
  }
  return null;
}

/** A model-supplied YYYY-MM-DD, accepted only when it is a real date. */
export function validIsoDate(s: unknown): string | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || fmt(d) !== s ? null : s;
}

/** due_text resolved here first; the model's date only when the phrase is not a shape this knows. */
export function pickDueDate(dueText: string | null | undefined, modelDate: unknown, said: Date): string | null {
  return resolveDueDate(dueText, said) ?? validIsoDate(modelDate);
}
