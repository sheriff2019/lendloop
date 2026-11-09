import { v, ConvexError } from "convex/values";

export const CATEGORIES = [
  "Power tools",
  "Hand tools",
  "Garden",
  "Kitchen",
  "Camping",
  "Cleaning",
  "Ladders",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];
export const categoryValidator = v.union(...CATEGORIES.map((c) => v.literal(c)));

export const CONDITIONS = ["Like new", "Good", "Fair", "Worn"] as const;
export type Condition = (typeof CONDITIONS)[number];
export const conditionValidator = v.union(...CONDITIONS.map((c) => v.literal(c)));

export const LOAN_STATUSES = ["pending", "approved", "declined", "cancelled", "returned"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];
export const loanStatusValidator = v.union(...LOAN_STATUSES.map((s) => v.literal(s)));

export const EVENT_TYPES = [
  "loan.requested",
  "loan.approved",
  "loan.declined",
  "loan.cancelled",
  "loan.returned",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const eventTypeValidator = v.union(...EVENT_TYPES.map((s) => v.literal(s)));

export const LIMITS = {
  nameMin: 2,
  nameMax: 60,
  descriptionMax: 280,
  noteMax: 200,
  loanMaxDays: 30,
  bookAheadDays: 90,
  maxOpenRequestsPerBorrower: 10,
  removeReasonMax: 200,
} as const;

/** Errors the UI can show as they are. `code` is stable for tests and clients. */
export function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

export function cleanText(value: string, label: string, min: number, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < min || text.length > max) {
    fail("INVALID_INPUT", `${label} must be ${min}–${max} characters.`);
  }
  return text;
}

// ---- Calendar days ----------------------------------------------------------
// Loans are booked by calendar day. "Today" is the neighbourhood's day, from
// APP_TIMEZONE (default UTC) — never the server's clock date.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayIn(timeZone: string | undefined, now: number = Date.now()): string {
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** Inclusive ranges [aStart, aEnd] and [bStart, bEnd] share at least one day. */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function today(): string {
  return todayIn(process.env.APP_TIMEZONE);
}
