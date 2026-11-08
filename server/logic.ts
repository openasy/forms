// What a form is once its file is read, in the language a page is shown in, and the rules both the page and the server
// apply to its answers: which pages and fields are shown (show_if), and whether an answer is valid. The page runs the
// same code to show its messages; the server runs it again and trusts nothing the page says. No Node or DOM here.

export type FieldType =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "number"
  | "url"
  | "date"
  | "choice"
  | "choices"
  | "select"
  | "yes_no"
  | "rating"
  | "scale"
  | "nps"
  | "file"
  | "consent"
  | "statement";

export const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "textarea",
  "email",
  "phone",
  "number",
  "url",
  "date",
  "choice",
  "choices",
  "select",
  "yes_no",
  "rating",
  "scale",
  "nps",
  "file",
  "consent",
  "statement",
];

/** An answer: text, a number, yes or no, the options ticked, or a file's id. */
export type Value = string | number | boolean | string[];
export type Answers = Record<string, Value>;

/** One test on an earlier answer; a list of them must all hold, and `any` holds when one of its own does. */
export type Condition =
  | { field: string; is?: string | number | boolean; not?: string | number | boolean; in?: string[]; answered?: boolean; above?: number; below?: number }
  | { any: Condition[] };

export interface PublicField {
  id: string;
  type: FieldType;
  label: string;
  help: string | null;
  placeholder: string | null;
  required: boolean;
  /** Characters for text, the value for numbers and scales, options ticked for choices. */
  min: number | null;
  max: number | null;
  pattern: string | null;
  patternMessage: string | null;
  options: Array<{ value: string; label: string }>;
  /** A scale's words at each end, such as Not likely and Very likely. */
  minLabel: string | null;
  maxLabel: string | null;
  /** Files: the types taken, as MIME types, and the largest size in bytes. */
  accept: string[];
  maxSize: number | null;
  /** A consent box: the purpose in Consent, the channels a tick agrees to, and the version of the text shown. */
  consent: { purpose: string; channels: string[]; version: number | null } | null;
  showIf: Condition[];
}

export interface PublicPage {
  title: string | null;
  description: string | null;
  showIf: Condition[];
  fields: PublicField[];
}

export interface PublicForm {
  id: string;
  name: string;
  kind: "lead" | "contact" | "nps" | "survey";
  language: string;
  title: string;
  description: string | null;
  pages: PublicPage[];
  /** Answers the page fills from its address or the embed's data- attributes, never shown. */
  hidden: string[];
  submit: string;
  thanks: string;
  redirect: string | null;
  /** Why it takes no answers now: closed (past closes, or closed in the file) or full (limit reached). */
  closed: "closed" | "full" | null;
  closedText: string | null;
  /** Signed when the page was served; it times the answer and is the proof-of-work's challenge. */
  token: string;
  spam: { honeypot: string; proofOfWork: number | null; captcha: { provider: "turnstile" | "hcaptcha"; siteKey: string } | null };
  /** What is kept of an answer not sent: nothing, how far it got, or the answers too. */
  partials: "off" | "progress" | "answers";
  /** Forms' own address, which the page sends to. */
  endpoint: string;
}

export type ErrorCode =
  | "required"
  | "too_short"
  | "too_long"
  | "too_small"
  | "too_large"
  | "pattern"
  | "email"
  | "phone"
  | "url"
  | "date"
  | "number"
  | "option"
  | "too_few"
  | "too_many"
  | "file";

export interface FieldError {
  field: string;
  code: ErrorCode;
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const PHONE = /^\+?[0-9 ().-]{7,24}$/;
/** Whether a field takes an answer: a statement is only text. */
export const answers = (f: PublicField) => f.type !== "statement";

function present(v: Value | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function same(a: Value | undefined, b: string | number | boolean): boolean {
  if (a === undefined) return false;
  if (Array.isArray(a)) return a.includes(String(b));
  if (typeof b === "boolean") return a === b || (typeof a === "string" && a === (b ? "yes" : "no"));
  return String(a) === String(b);
}

/** Whether a condition holds on the answers given so far. */
export function holds(c: Condition, a: Answers): boolean {
  if ("any" in c) return c.any.some((x) => holds(x, a));
  const v = a[c.field];
  if (c.answered !== undefined && present(v) !== c.answered) return false;
  if (c.is !== undefined && !same(v, c.is)) return false;
  if (c.not !== undefined && same(v, c.not)) return false;
  if (c.in !== undefined && !c.in.some((x) => same(v, x))) return false;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (c.above !== undefined && !(n > c.above)) return false;
  if (c.below !== undefined && !(n < c.below)) return false;
  return true;
}

const all = (cs: Condition[], a: Answers) => cs.every((c) => holds(c, a));

/**
 * The pages and fields shown for these answers, in order. A field that is not shown does not count: its answer is
 * dropped before any later condition reads it, so a hidden answer cannot open a page.
 */
export function shown(form: Pick<PublicForm, "pages" | "hidden">, given: Answers): { pages: number[]; fields: PublicField[]; answers: Answers } {
  const kept: Answers = {};
  for (const h of form.hidden) if (typeof given[h] === "string") kept[h] = given[h];
  const pages: number[] = [];
  const fields: PublicField[] = [];
  form.pages.forEach((p, i) => {
    if (!all(p.showIf, kept)) return;
    pages.push(i);
    for (const f of p.fields) {
      if (!all(f.showIf, kept)) continue;
      fields.push(f);
      // Conditions read the answer as it is kept: a valid one only, numbers as numbers.
      const v = answers(f) ? check(f, given[f.id]).value : undefined;
      if (v !== undefined) kept[f.id] = v;
    }
  });
  return { pages, fields, answers: kept };
}

/** The answer as the field keeps it, or an error. Numbers may come as text from a page's input. */
export function check(f: PublicField, raw: Value | undefined): { value?: Value; error?: ErrorCode } {
  if (!present(raw)) return f.required ? { error: "required" } : {};
  const v = raw!;
  const len = (s: string) => [...s].length;
  switch (f.type) {
    case "statement":
      return {};
    case "text":
    case "textarea":
    case "email":
    case "phone":
    case "url": {
      if (typeof v !== "string") return { error: "required" };
      const s = v.trim();
      const max = f.max ?? (f.type === "textarea" ? 5000 : 300);
      if (len(s) > max) return { error: "too_long" };
      if (f.min !== null && len(s) < f.min) return { error: "too_short" };
      if (f.type === "email" && (!EMAIL.test(s) || s.length > 254)) return { error: "email" };
      if (f.type === "phone" && (!PHONE.test(s) || s.replace(/\D/g, "").length < 7)) return { error: "phone" };
      if (f.type === "url") {
        let u: URL | null = null;
        try {
          u = new URL(s);
        } catch {
          u = null;
        }
        if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return { error: "url" };
      }
      if (f.pattern && !new RegExp(f.pattern, "u").test(s)) return { error: "pattern" };
      return { value: f.type === "email" ? s.toLowerCase() : s };
    }
    case "number":
    case "rating":
    case "scale":
    case "nps": {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace(",", ".")) : NaN;
      if (!Number.isFinite(n)) return { error: "number" };
      const [min, max] = f.type === "nps" ? [0, 10] : f.type === "rating" ? [1, f.max ?? 5] : [f.min, f.max];
      if (f.type !== "number" && !Number.isInteger(n)) return { error: "number" };
      if (min !== null && n < min) return { error: "too_small" };
      if (max !== null && n > max) return { error: "too_large" };
      return { value: n };
    }
    case "date": {
      const ok = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
      return ok ? { value: v } : { error: "date" };
    }
    case "choice":
    case "select": {
      const s = String(v);
      return f.options.some((o) => o.value === s) ? { value: s } : { error: "option" };
    }
    case "choices": {
      const list = Array.isArray(v) ? v.map(String) : [String(v)];
      if (list.some((x) => !f.options.some((o) => o.value === x))) return { error: "option" };
      const unique = f.options.map((o) => o.value).filter((o) => list.includes(o));
      if (f.min !== null && unique.length < f.min) return { error: "too_few" };
      if (f.max !== null && unique.length > f.max) return { error: "too_many" };
      return { value: unique };
    }
    case "yes_no": {
      const b = v === true || v === "yes" || v === "true" ? true : v === false || v === "no" || v === "false" ? false : null;
      return b === null ? { error: "option" } : { value: b };
    }
    case "consent": {
      // Unticked is no and is never recorded; a required box must be ticked.
      const b = v === true || v === "yes" || v === "true" || v === "on";
      if (!b) return f.required ? { error: "required" } : {};
      return { value: true };
    }
    case "file":
      return typeof v === "string" && /^[A-Za-z0-9_-]{16,40}$/.test(v) ? { value: v } : { error: "file" };
  }
}

/** Checks the answers to the pages shown, up to and including `upTo` (every page by default). */
export function validate(form: Pick<PublicForm, "pages" | "hidden">, given: Answers, upTo = Infinity): { answers: Answers; errors: FieldError[] } {
  const { fields } = shown(form, given);
  const out: Answers = {};
  const errors: FieldError[] = [];
  for (const h of form.hidden) {
    const v = given[h];
    if (typeof v === "string" && v.trim()) out[h] = v.trim().slice(0, 500);
  }
  for (const f of fields) {
    if (!answers(f)) continue;
    if (form.pages.findIndex((p) => p.fields.includes(f)) > upTo) continue;
    const r = check(f, given[f.id]);
    if (r.error) errors.push({ field: f.id, code: r.error });
    else if (r.value !== undefined) out[f.id] = r.value;
  }
  return { answers: out, errors };
}

/** The words of an answer for a person: the option's label, Yes or No, the list joined. */
export function display(f: PublicField | undefined, v: Value | undefined, yes = "Yes", no = "No"): string {
  if (v === undefined) return "";
  const label = (x: string) => f?.options.find((o) => o.value === x)?.label ?? x;
  if (Array.isArray(v)) return v.map(label).join(", ");
  if (typeof v === "boolean") return v ? yes : no;
  if (f && (f.type === "choice" || f.type === "select")) return label(String(v));
  return String(v);
}
