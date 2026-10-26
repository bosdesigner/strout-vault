// What never reaches the database: card numbers, SSNs, bank routing/account numbers (replaced
// with [REDACTED] before any write) and one-time codes (the whole message is dropped). Every
// text the message ingest stores (bodies, subjects, display names, attachment names) goes
// through redactSensitive first, and every message goes through isOneTimeCode. Nothing here
// logs: callers count what was dropped, they never print it.

export const REDACTED = "[REDACTED]";

/** Luhn checksum over a digit string. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ABA routing number checksum (3-7-1 weights). */
export function abaValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0 && digits !== "000000000";
}

// 13-19 digits, optionally grouped by single spaces or dashes ("4111 1111 1111 1111").
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const SSN = /(?<!\d)\d{3}([- ])\d{2}\1\d{4}(?!\d)/g;
const SSN_CONTEXT = /\b(ssn|social security|soc sec|ss#)\b[^\d\n]{0,20}(\d{9})(?!\d)/gi;
const ROUTING_CONTEXT = /\b(routing|aba|rtn|transit)\b[^\d\n]{0,25}(\d{9})(?!\d)/gi;
const ACCOUNT_CONTEXT = /\b(account|acct|a\/c)\b(?:\s*(?:number|num|no\.?|#))?[^\d\n]{0,15}(\d[\d -]{2,20}\d)(?!\d)/gi;
const BARE_ABA = /(?<!\d)\d{9}(?!\d)/g;

export interface RedactResult {
  text: string;
  /** How many values were replaced. */
  count: number;
}

/** Replaces card numbers, SSNs and bank routing/account numbers with [REDACTED]. */
export function redactSensitive(input: string | null | undefined): RedactResult {
  if (!input) return { text: input ?? "", count: 0 };
  let count = 0;
  let text = input.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      count++;
      return REDACTED;
    }
    return m;
  });
  text = text.replace(SSN, () => {
    count++;
    return REDACTED;
  });
  text = text.replace(SSN_CONTEXT, (m, _k, digits: string) => {
    count++;
    return m.replace(digits, REDACTED);
  });
  text = text.replace(ROUTING_CONTEXT, (m, _k, digits: string) => {
    count++;
    return m.replace(digits, REDACTED);
  });
  text = text.replace(ACCOUNT_CONTEXT, (m, _k, digits: string) => {
    if (digits.replace(/\D/g, "").length < 4) return m;
    count++;
    return m.replace(digits, REDACTED);
  });
  // A bare 9-digit number that passes the ABA checksum next to bank words anywhere in the message.
  if (/\b(bank|routing|wire|ach|deposit)\b/i.test(text)) {
    text = text.replace(BARE_ABA, (m) => {
      if (!abaValid(m)) return m;
      count++;
      return REDACTED;
    });
  }
  return { text, count };
}

const OTP_DIGITS = /(?<![\d.,$])\d{4,8}(?![\d.,])/;
const OTP_WORDS = /\b(code|codes|verification|verify|otp|passcode|pass code|one[- ]time|2fa|security code|login code|sign[- ]in code)\b/i;

/** True for a message that looks like a one-time / verification code: it is dropped, never stored. */
export function isOneTimeCode(text: string | null | undefined): boolean {
  if (!text) return false;
  return OTP_DIGITS.test(text) && OTP_WORDS.test(text);
}

const OTP_NEAR = /(\b(?:code|verification|verify|otp|passcode|one[- ]time|2fa)\b[^\d\n]{0,40})(\d{4,8})(?!\d)|(?<!\d)(\d{4,8})([^\d\n]{0,40}\b(?:code|verification|otp|passcode)\b)/gi;

/**
 * For long texts (email bodies) where dropping the whole message on the word "code" would lose
 * real correspondence: replaces only the 4-8 digit runs that sit next to a code word.
 */
export function redactOneTimeCodes(input: string): RedactResult {
  let count = 0;
  const text = input.replace(OTP_NEAR, (m, pre?: string, d1?: string, d2?: string, post?: string) => {
    count++;
    if (d1 !== undefined) return `${pre}${REDACTED}`;
    if (d2 !== undefined) return `${REDACTED}${post}`;
    return m;
  });
  return { text, count };
}
