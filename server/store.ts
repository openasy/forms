// What the parts of Forms share: the error the API turns into a problem, who does something, and the database helpers.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Role } from "@openasy/auth";
import type { FieldError } from "./logic.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "invalid-answers"
  | "forbidden"
  | "forbidden-origin"
  | "not-found"
  | "conflict"
  | "closed"
  | "expired"
  | "proof-of-work"
  | "captcha-failed"
  | "unsupported-file"
  | "rate-limited"
  | "payload-too-large"
  | "internal-error";

export class FormsError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  /** For invalid-answers: each field and what is wrong with it. */
  readonly errors?: Array<FieldError & { message: string }>;
  constructor(status: number, code: ProblemCode, message: string, extra: { retryAfter?: number; errors?: Array<FieldError & { message: string }> } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter;
    this.errors = extra.errors;
  }
}

/** Who does something: a signed-in member, an API token, or the tests' admin token. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export const bad = (message: string) => new FormsError(422, "invalid-body", message);
export const notFound = (what: string) => new FormsError(404, "not-found", `${what} does not exist.`);
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const DAY = 86_400_000;
export const MINUTE = 60_000;

export function createStore(db: DatabaseSync, clock: () => number) {
  let depth = 0;
  return {
    db,
    clock,
    iso: (ms = clock()) => new Date(ms).toISOString(),
    q: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[],
    one: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined,
    run: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args),
    /** Runs fn in one write transaction (BEGIN IMMEDIATE), so a check and the write after it are not split. */
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}
export type Store = ReturnType<typeof createStore>;

/** The body as a map, or a 422 that says what it takes. */
export function body(v: unknown, takes: string[]): Record<string, unknown> {
  if (!isObj(v)) throw bad(`The body is a JSON object with ${takes.join(", ")}.`);
  const extra = Object.keys(v).filter((k) => !takes.includes(k));
  if (extra.length) throw bad(`unknown ${extra.join(", ")}; it takes ${takes.join(", ")}.`);
  return v;
}

/** Phone numbers compared by their digits, with Turkey's leading 0 written as 90: 0532 000 00 12 is 905320000012. */
export function phoneKey(v: string | null | undefined): string | null {
  if (!v) return null;
  let d = v.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = `90${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith("5")) d = `90${d}`;
  return d.length >= 7 ? d : null;
}
