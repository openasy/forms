// Forms' settings, from one YAML file (FORMS_CONFIG): every form with its pages, fields, conditions and where its
// answers go, the spam filters, what is kept of answers not sent, the mail server, the Analytics script of the form
// pages, and the links to Consent, Audience, CRM, Helpdesk and webhooks. As in the other products, the file is the
// only way in: no screen or API route changes a form, so forms are reviewed like code. It is applied whole or not at
// all, read again within a minute of a change, and a file with a mistake leaves the last good version in place. The
// answers are kept in the database.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { FIELD_TYPES, type Condition, type FieldType } from "./logic.ts";

export const LANGS = ["en", "tr", "de"] as const;
export type Lang = (typeof LANGS)[number];
/** A text in each of en, tr and de, or one text for every page (any). */
export type Text = Partial<Record<Lang | "any", string>>;

export interface FieldDef {
  id: string;
  type: FieldType;
  label: Text;
  help: Text | null;
  placeholder: Text | null;
  required: boolean;
  min: number | null;
  max: number | null;
  pattern: string | null;
  patternMessage: Text | null;
  options: Array<{ value: string; label: Text }>;
  minLabel: Text | null;
  maxLabel: Text | null;
  /** Files: MIME types taken and the largest size in bytes. */
  accept: string[];
  maxSize: number | null;
  /** A consent box: the purpose in Consent and the channels a tick agrees to. */
  consent: { purpose: string; channels: Channel[] } | null;
  showIf: Condition[];
  /** The Audience trait this answer sets, such as city. */
  trait: string | null;
}

export interface PageDef {
  title: Text | null;
  description: Text | null;
  showIf: Condition[];
  fields: FieldDef[];
}

export type Channel = "email" | "sms" | "call" | "web";
export type Kind = "lead" | "contact" | "nps" | "survey";
export type PartialMode = "off" | "progress" | "answers";

export interface Spam {
  /** An answer sent sooner than this after the page was served is taken for a bot's. */
  minSeconds: number;
  /** Answers a form takes from one address: `n` in `perMs`. */
  rate: { n: number; perMs: number; text: string };
  /** Leading zero bits the page's proof of work must find; null for none. */
  proofOfWork: number | null;
  /** Whether the file's captcha is asked on this form. */
  captcha: boolean;
}

export interface CrmSend {
  /** The deal's name, with {field} replaced by answers. */
  title: string | null;
  /** The member who owns the lead, by email; owner_by picks one by an answer first. */
  owner: string | null;
  ownerBy: { field: string; owners: Record<string, string> } | null;
  value: number | null;
}

export interface HelpdeskSend {
  /** What Helpdesk's routing rules match as match.form. */
  form: string;
  subject: string | null;
  /** The field whose answer is the ticket's message; else every answer. */
  message: string | null;
}

export interface FormDef {
  id: string;
  /** Where it is written: forms.yaml, or its own file in the forms folder (forms/demo.yaml). */
  file: string;
  name: string;
  kind: Kind;
  title: Text;
  description: Text | null;
  pages: PageDef[];
  hidden: string[];
  submit: Text | null;
  thanks: Text | null;
  /** Where the page goes after an answer, on https; ?response=<id> is added. */
  redirect: string | null;
  closed: boolean;
  /** No answers after this moment (ISO). */
  closes: string | null;
  /** No answers after this many. */
  limit: number | null;
  closedText: Text | null;
  /** Origins whose pages may embed the form with the script tag or a frame. */
  embed: string[];
  /** Which answers say who the person is, for Consent, Audience, CRM, Helpdesk and deletion. */
  person: { email: string | null; phone: string | null; name: string | null; company: string | null; userId: string | null };
  spam: Spam;
  partials: PartialMode;
  send: { audience: boolean; crm: CrmSend | null; helpdesk: HelpdeskSend | null; notify: string[]; webhooks: string[] };
}

export interface Link {
  url: string;
  /** The environment variable with the token, never the token. */
  token: string;
}

export interface Config {
  language: Lang;
  timeZone: string;
  forms: FormDef[];
  keep: { partialDays: number; spamDays: number; responseDays: number | null };
  mail: { host: string; port: number; security: "starttls" | "tls" | "none"; user: string | null; password: string; from: string } | null;
  /** The script of an OpenAsy Analytics site, put on every form page. */
  analytics: string | null;
  captcha: { provider: "turnstile" | "hcaptcha"; siteKey: string; secret: string } | null;
  consent: Link | null;
  audience: Link | null;
  crm: Link | null;
  helpdesk: { url: string; key: string } | null;
  webhooks: Array<{ id: string; url: string; secret: string }>;
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD_ID = /^[a-z][a-z0-9_]{0,39}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOP = [
  "language",
  "time_zone",
  "forms",
  "spam",
  "partials",
  "keep",
  "mail",
  "analytics",
  "captcha",
  "consent",
  "audience",
  "crm",
  "helpdesk",
  "webhooks",
];
const FORM_KEYS = [
  "name",
  "kind",
  "title",
  "description",
  "pages",
  "fields",
  "hidden",
  "submit",
  "thanks",
  "redirect",
  "closed",
  "closes",
  "limit",
  "closed_text",
  "embed",
  "person",
  "spam",
  "partials",
  "send_to",
];
const FIELD_KEYS = [
  "id",
  "type",
  "label",
  "text",
  "help",
  "placeholder",
  "required",
  "min",
  "max",
  "pattern",
  "pattern_message",
  "options",
  "min_label",
  "max_label",
  "types",
  "max_size",
  "purpose",
  "channels",
  "show_if",
  "trait",
];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function plain(v: unknown, at: string, max = 80): string {
  if ((typeof v !== "string" && typeof v !== "number") || !String(v).trim() || String(v).length > max)
    throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return String(v).trim();
}

/** A text, or a map of en, tr and de. */
function text(v: unknown, at: string, max = 300): Text {
  if (isObj(v)) {
    keys(v, at, [...LANGS]);
    const t: Text = {};
    for (const l of LANGS) if (v[l] !== undefined) t[l] = plain(v[l], `${at}.${l}`, max);
    if (!Object.keys(t).length) throw new Error(`${at} is a text, or a map of en, tr and de.`);
    return t;
  }
  return { any: plain(v, at, max) };
}
const optText = (v: unknown, at: string, max = 300): Text | null => (v === undefined || v === null ? null : text(v, at, max));

/** A text in the page's language, else the file's, else any. */
export function pick(t: Text, lang: Lang, fallback: Lang): string {
  return t[lang] ?? t.any ?? t[fallback] ?? t.en ?? Object.values(t)[0] ?? "";
}

/** The languages a form is written in: those of its title, else the file's language. */
export function formLanguages(f: FormDef, fallback: Lang): Lang[] {
  const ls = LANGS.filter((l) => f.title[l] !== undefined);
  return ls.length ? ls : [fallback];
}

function env(v: unknown, at: string, example: string): string {
  if (typeof v !== "string" || !ENV.test(v)) throw new Error(`${at} is the name of an environment variable, such as ${example}, never the secret itself.`);
  return v;
}

function bool(v: unknown, at: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new Error(`${at} is true or false.`);
  return v;
}

function int(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${at} is a whole number from ${min} to ${max}.`);
  return v;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, y: 365 * 86_400_000 };
/** 3s, 30m, 4h, 30d, 2y: a duration in milliseconds. */
export function duration(v: unknown, at: string, units = "smhdy"): number {
  const m = /^(\d{1,6})\s*([smhdy])$/.exec(String(v ?? "").trim());
  if (!m || !units.includes(m[2]!)) {
    const ex: Record<string, string> = { s: "3s", m: "30m", h: "4h", d: "30d", y: "2y" };
    throw new Error(`${at} is a duration such as ${[...units].map((u) => ex[u]).join(" or ")}.`);
  }
  return Number(m[1]) * UNITS[m[2]!]!;
}

/** 5MB, 500KB: a size in bytes. */
function size(v: unknown, at: string): number {
  const m = /^(\d{1,5})\s*(KB|MB)$/i.exec(String(v ?? "").trim());
  if (!m) throw new Error(`${at} is a size such as 500KB or 5MB.`);
  return Number(m[1]) * (m[2]!.toUpperCase() === "KB" ? 1024 : 1024 * 1024);
}

/** An address of another product: https://, or http:// inside the install (localhost, or a host without dots). */
function baseUrl(raw: unknown, at: string, example: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const inside = url && (/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && inside)) || url.search || url.hash)
    throw new Error(
      `${at} is an https:// address, such as https://${example}.example.com (http:// only for a host without dots, such as http://${example}:8080).`,
    );
  return url.origin + url.pathname.replace(/\/$/, "");
}

function origin(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.pathname !== "/" || url.search || url.hash)
    throw new Error(`${at} is an origin such as https://www.example.com (http:// only for localhost), with no path.`);
  return url.origin;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !EMAIL.test(v.trim()) || v.length > 254) throw new Error(`${at} is an email address.`);
  return v.trim().toLowerCase();
}

/** File types a form may take: only what Forms can tell from a file's bytes. */
export const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/plain",
};

interface Scope {
  /** Field ids a condition may read: hidden fields and fields before it. */
  before: Map<string, FieldType | "hidden">;
}

function condition(v: unknown, at: string, scope: Scope): Condition {
  if (!isObj(v)) throw new Error(`${at} is a condition such as { field: size, is: 51-200 }.`);
  if ("any" in v) {
    keys(v, at, ["any"]);
    if (!Array.isArray(v.any) || v.any.length < 1 || v.any.length > 20) throw new Error(`${at}.any is a list of 1 to 20 conditions.`);
    return { any: v.any.map((c, i) => condition(c, `${at}.any[${i}]`, scope)) };
  }
  keys(v, at, ["field", "is", "not", "in", "answered", "above", "below"]);
  const field = typeof v.field === "string" ? v.field : "";
  if (!scope.before.has(field))
    throw new Error(`${at}.field: ${field || "(none)"} is not a hidden field or a field before this one; a condition reads only answers already given.`);
  const tests = ["is", "not", "in", "answered", "above", "below"].filter((k) => v[k] !== undefined);
  if (!tests.length) throw new Error(`${at} needs one of is, not, in, answered, above or below.`);
  const c: Condition = { field };
  const scalar = (x: unknown, k: string) => {
    if (typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean") throw new Error(`${at}.${k} is a text, a number, or true or false.`);
    return x;
  };
  if (v.is !== undefined) c.is = scalar(v.is, "is");
  if (v.not !== undefined) c.not = scalar(v.not, "not");
  if (v.in !== undefined) {
    if (!Array.isArray(v.in) || !v.in.length || v.in.length > 50) throw new Error(`${at}.in is a list of 1 to 50 values.`);
    c.in = v.in.map((x) => String(scalar(x, "in")));
  }
  if (v.answered !== undefined) c.answered = bool(v.answered, `${at}.answered`, true);
  for (const k of ["above", "below"] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== "number") throw new Error(`${at}.${k} is a number.`);
    c[k] = v[k] as number;
  }
  return c;
}

function conditions(v: unknown, at: string, scope: Scope): Condition[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.length > 20) throw new Error(`${at} is a condition or a list of up to 20, which must all hold.`);
  return list.map((c, i) => condition(c, Array.isArray(v) ? `${at}[${i}]` : at, scope));
}

function field(v: unknown, at: string, scope: Scope): FieldDef {
  if (!isObj(v)) throw new Error(`${at} is a field: { id, type, label, required }.`);
  keys(v, at, FIELD_KEYS);
  const type = (v.type ?? "text") as FieldType;
  if (!FIELD_TYPES.includes(type)) throw new Error(`${at}.type is one of ${FIELD_TYPES.join(", ")}.`);
  const id = v.id === undefined && type === "statement" ? `statement_${scope.before.size}` : String(v.id ?? "");
  if (!FIELD_ID.test(id)) throw new Error(`${at}.id is up to 40 lowercase letters, digits and _, starting with a letter.`);
  if (scope.before.has(id)) throw new Error(`${at}.id: ${id} is used twice in the form.`);
  const showIf = conditions(v.show_if, `${at}.show_if`, scope);
  const labelRaw = v.label ?? v.text;
  if (labelRaw === undefined) throw new Error(`${at}.label is the question as people read it.`);
  const label = text(labelRaw, `${at}.label`, type === "statement" || type === "consent" ? 2000 : 300);
  const num = (k: string) => {
    const x = v[k];
    if (x === undefined || x === null) return null;
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${at}.${k} is a number.`);
    return x;
  };
  let min = num("min");
  let max = num("max");
  const options: FieldDef["options"] = [];
  if (type === "choice" || type === "choices" || type === "select") {
    if (!Array.isArray(v.options) || v.options.length < 1 || v.options.length > 100) throw new Error(`${at}.options is a list of 1 to 100 options.`);
    v.options.forEach((o, i) => {
      const oat = `${at}.options[${i}]`;
      if (isObj(o)) {
        keys(o, oat, ["value", "label"]);
        options.push({
          value: plain(o.value, `${oat}.value`, 100),
          label: o.label === undefined ? { any: String(o.value) } : text(o.label, `${oat}.label`, 200),
        });
      } else options.push({ value: plain(o, oat, 100), label: { any: String(o).trim() } });
    });
    const dup = options.find((o, i) => options.findIndex((x) => x.value === o.value) !== i);
    if (dup) throw new Error(`${at}.options: ${dup.value} is in the list twice.`);
  } else if (v.options !== undefined) throw new Error(`${at}.options are only for choice, choices and select.`);
  if (type === "rating") {
    max = max ?? 5;
    if (!Number.isInteger(max) || max < 3 || max > 10) throw new Error(`${at}.max of a rating is 3 to 10 stars.`);
    min = null;
  }
  if (type === "scale") {
    min = min ?? 1;
    max = max ?? 5;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 10 || max - min < 2)
      throw new Error(`${at}: a scale goes from min 0 or 1 to max up to 10.`);
  }
  if (type === "nps") [min, max] = [0, 10];
  if (min !== null && max !== null && min > max) throw new Error(`${at}.min is more than max.`);
  if (["text", "textarea", "email", "phone", "url"].includes(type)) {
    if (min !== null && (!Number.isInteger(min) || min < 0)) throw new Error(`${at}.min is the fewest characters.`);
    const limit = type === "textarea" ? 20_000 : 1000;
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > limit)) throw new Error(`${at}.max is the most characters, up to ${limit}.`);
  }
  let pattern: string | null = null;
  if (v.pattern !== undefined) {
    if (type !== "text" && type !== "phone") throw new Error(`${at}.pattern is only for text and phone fields.`);
    pattern = plain(v.pattern, `${at}.pattern`, 300);
    try {
      new RegExp(pattern, "u");
    } catch {
      throw new Error(`${at}.pattern is not a regular expression.`);
    }
  }
  let accept: string[] = [];
  let maxSize: number | null = null;
  if (type === "file") {
    const types = v.types ?? ["pdf", "png", "jpeg"];
    if (!Array.isArray(types) || !types.length) throw new Error(`${at}.types is a list of ${Object.keys(FILE_TYPES).join(", ")}.`);
    accept = [
      ...new Set(
        types.map((x) => {
          const m = FILE_TYPES[String(x).toLowerCase()];
          if (!m) throw new Error(`${at}.types: ${String(x)} is not one of ${Object.keys(FILE_TYPES).join(", ")}.`);
          return m;
        }),
      ),
    ];
    maxSize = v.max_size === undefined ? 5 * 1024 * 1024 : size(v.max_size, `${at}.max_size`);
    if (maxSize > 20 * 1024 * 1024 || maxSize < 1024) throw new Error(`${at}.max_size is 1KB to 20MB.`);
  } else if (v.types !== undefined || v.max_size !== undefined) throw new Error(`${at}.types and max_size are only for file fields.`);
  let consent: FieldDef["consent"] = null;
  if (type === "consent") {
    if (typeof v.purpose !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.purpose))
      throw new Error(`${at}.purpose is the id of a purpose in Consent, such as marketing.`);
    const ch = v.channels ?? ["email"];
    if (!Array.isArray(ch) || !ch.length || ch.some((c) => !["email", "sms", "call", "web"].includes(String(c))))
      throw new Error(`${at}.channels is a list of email, sms, call and web.`);
    consent = { purpose: v.purpose, channels: [...new Set(ch as Channel[])] };
  } else if (v.purpose !== undefined || v.channels !== undefined) throw new Error(`${at}.purpose and channels are only for consent boxes.`);
  if (type === "statement" && v.required) throw new Error(`${at}: a statement takes no answer, so it cannot be required.`);
  let trait: string | null = null;
  if (v.trait !== undefined) {
    if (typeof v.trait !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(v.trait)) throw new Error(`${at}.trait is the name of an Audience trait, such as city.`);
    if (["file", "consent", "statement"].includes(type)) throw new Error(`${at}.trait: a ${type} field sets no trait.`);
    trait = v.trait;
  }
  scope.before.set(id, type);
  return {
    id,
    type,
    label,
    help: optText(v.help, `${at}.help`, 500),
    placeholder: optText(v.placeholder, `${at}.placeholder`, 120),
    required: bool(v.required, `${at}.required`, false),
    min,
    max,
    pattern,
    patternMessage: optText(v.pattern_message, `${at}.pattern_message`, 200),
    options,
    minLabel: optText(v.min_label, `${at}.min_label`, 60),
    maxLabel: optText(v.max_label, `${at}.max_label`, 60),
    accept,
    maxSize,
    consent,
    showIf,
    trait,
  };
}

const DEFAULT_SPAM: Spam = { minSeconds: 3, rate: { n: 5, perMs: 60_000, text: "5/m" }, proofOfWork: null, captcha: true };

function spam(v: unknown, at: string, base: Spam): Spam {
  if (v === undefined || v === null) return base;
  if (!isObj(v)) throw new Error(`${at} is a map with min_time, rate, proof_of_work and captcha.`);
  keys(v, at, ["min_time", "rate", "proof_of_work", "captcha"]);
  const s = { ...base };
  if (v.min_time !== undefined) {
    s.minSeconds = duration(v.min_time, `${at}.min_time`, "s") / 1000;
    if (s.minSeconds > 120) throw new Error(`${at}.min_time is 0s to 120s.`);
  }
  if (v.rate !== undefined) {
    const m = /^(\d{1,4})\s*\/\s*(\d{0,4})\s*([mhd])$/.exec(String(v.rate).trim());
    const per = m ? Number(m[2] || 1) * UNITS[m[3]!]! : 0;
    if (!m || Number(m[1]) < 1 || per < 60_000 || per > 7 * 86_400_000)
      throw new Error(`${at}.rate is answers from one address in a time, such as 5/10m, 30/h or 100/d.`);
    s.rate = { n: Number(m[1]), perMs: per, text: `${m[1]}/${m[2] ?? ""}${m[3]}` };
  }
  if (v.proof_of_work !== undefined) {
    const p = v.proof_of_work;
    if (p === false || p === null) s.proofOfWork = null;
    else if (p === true) s.proofOfWork = 16;
    else s.proofOfWork = int(p, `${at}.proof_of_work`, 8, 22);
  }
  if (v.captcha !== undefined) s.captcha = bool(v.captcha, `${at}.captcha`, true);
  return s;
}

function partials(v: unknown, at: string, fallback: PartialMode): PartialMode {
  if (v === undefined || v === null) return fallback;
  if (v === false) return "off";
  if (v !== "off" && v !== "progress" && v !== "answers") throw new Error(`${at} is off, progress (how far people got) or answers (what they wrote too).`);
  return v;
}

function link(v: unknown, at: string, product: string, tokenKey = "token"): { url: string; token: string } | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new Error(`${at} is a map with url and ${tokenKey}.`);
  keys(v, at, ["url", tokenKey]);
  const envName = `FORMS_${product.toUpperCase()}_${tokenKey.toUpperCase()}`;
  return { url: baseUrl(v.url, `${at}.url`, product), token: v[tokenKey] === undefined ? envName : env(v[tokenKey], `${at}.${tokenKey}`, envName) };
}

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string, files: Array<{ name: string; text: string }> = [], fileName = "forms.yaml"): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const language = (doc.language ?? "en") as Lang;
  if (!LANGS.includes(language)) throw new Error("language is en, tr or de: the form pages' language when the browser asks for none of them.");
  const timeZone = doc.time_zone === undefined ? "Europe/Istanbul" : plain(doc.time_zone, "time_zone", 64);
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(`time_zone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);
  }

  const baseSpam = spam(doc.spam, "spam", DEFAULT_SPAM);
  const basePartials = partials(doc.partials, "partials", "progress");

  const kp = doc.keep ?? {};
  if (!isObj(kp)) throw new Error("keep is a map with responses, partials and spam.");
  keys(kp, "keep", ["responses", "partials", "spam"]);
  const days = (x: unknown, k: string, fallback: number) => {
    if (x === undefined) return fallback;
    const d = Math.round(duration(x, `keep.${k}`, "dy") / 86_400_000);
    if (d < 1 || d > 3650) throw new Error(`keep.${k} is 1d to 10y.`);
    return d;
  };
  const keep = {
    partialDays: days(kp.partials, "partials", 30),
    spamDays: days(kp.spam, "spam", 30),
    responseDays: kp.responses === undefined || kp.responses === "forever" ? null : days(kp.responses, "responses", 0),
  };

  let mail: Config["mail"] = null;
  if (doc.mail !== undefined && doc.mail !== null) {
    const m = doc.mail;
    if (!isObj(m)) throw new Error("mail is a map with host, port, security, user, password and from.");
    keys(m, "mail", ["host", "port", "security", "user", "password", "from"]);
    const security = m.security ?? "starttls";
    if (security !== "starttls" && security !== "tls" && security !== "none") throw new Error("mail.security is starttls, tls or none.");
    const host = plain(m.host, "mail.host", 253);
    if (security === "none" && !/^(localhost|127\.0\.0\.1)$/.test(host) && host.includes("."))
      throw new Error("mail.security none is only for a server on this machine or the install's network; use starttls or tls.");
    const port = m.port ?? (security === "tls" ? 465 : 587);
    mail = {
      host,
      port: int(port, "mail.port", 1, 65535),
      security,
      user: m.user === undefined || m.user === null ? null : plain(m.user, "mail.user", 254),
      password: m.password === undefined ? "FORMS_MAIL_PASSWORD" : env(m.password, "mail.password", "FORMS_MAIL_PASSWORD"),
      from: plain(m.from, "mail.from", 254),
    };
  }

  let analytics: string | null = null;
  if (doc.analytics !== undefined && doc.analytics !== null) {
    const u = typeof doc.analytics === "string" ? URL.parse(doc.analytics.trim()) : null;
    const local = u && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    if (!u || (u.protocol !== "https:" && !(u.protocol === "http:" && local)) || !/^\/s\/[a-z0-9-]+\.js$/.test(u.pathname) || u.search || u.hash)
      throw new Error("analytics is the script of an Analytics site, such as https://analytics.example.com/s/forms.js.");
    analytics = u.href;
  }

  let captcha: Config["captcha"] = null;
  if (doc.captcha !== undefined && doc.captcha !== null) {
    const c = doc.captcha;
    if (!isObj(c)) throw new Error("captcha is a map with provider, site_key and secret.");
    keys(c, "captcha", ["provider", "site_key", "secret"]);
    if (c.provider !== "turnstile" && c.provider !== "hcaptcha") throw new Error("captcha.provider is turnstile (Cloudflare) or hcaptcha.");
    captcha = {
      provider: c.provider,
      siteKey: plain(c.site_key, "captcha.site_key", 100),
      secret: c.secret === undefined ? "FORMS_CAPTCHA_SECRET" : env(c.secret, "captcha.secret", "FORMS_CAPTCHA_SECRET"),
    };
  }

  const consent = link(doc.consent, "consent", "consent");
  const audience = link(doc.audience, "audience", "audience");
  const crm = link(doc.crm, "crm", "crm");
  const hd = link(doc.helpdesk, "helpdesk", "helpdesk", "key");
  const helpdesk = hd && { url: hd.url, key: hd.token };

  const webhooks: Config["webhooks"] = [];
  const wh = doc.webhooks ?? {};
  if (!isObj(wh) || Object.keys(wh).length > 20) throw new Error("webhooks is a map of up to 20 webhooks, such as zapier: { url, secret }.");
  for (const [id, v] of Object.entries(wh)) {
    const at = `webhooks.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: a webhook id is up to 40 lowercase letters, digits and -.`);
    if (!isObj(v)) throw new Error(`${at} is a map with url and secret.`);
    keys(v, at, ["url", "secret"]);
    const u = typeof v.url === "string" ? URL.parse(v.url.trim()) : null;
    const inside = u && (/^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !u.hostname.includes("."));
    if (!u || (u.protocol !== "https:" && !(u.protocol === "http:" && inside)) || u.username || u.password)
      throw new Error(`${at}.url is an https:// address (http:// only inside the install), with no user or password in it.`);
    webhooks.push({ id, url: u.href, secret: v.secret === undefined ? "FORMS_WEBHOOK_SECRET" : env(v.secret, `${at}.secret`, "FORMS_WEBHOOK_SECRET") });
  }

  // The forms.
  const forms: FormDef[] = [];
  const fs = doc.forms ?? {};
  if (!isObj(fs)) throw new Error("forms is a map of forms, such as demo: { name, fields }.");
  // Forms in the file, then one form in each file of the forms folder, named by its id: forms/demo.yaml.
  const entries: Array<{ id: string; v: unknown; at: string; file: string }> = Object.entries(fs).map(([id, v]) => ({
    id,
    v,
    at: `forms.${id}`,
    file: fileName,
  }));
  for (const f of files) {
    const id = f.name.replace(/\.ya?ml$/, "");
    const at = `forms/${f.name}`;
    let v: unknown;
    try {
      v = parse(f.text);
    } catch (err) {
      throw new Error(`${at}: not valid YAML: ${(err as Error).message.split("\n")[0]}`);
    }
    if (entries.some((e) => e.id === id)) throw new Error(`${at}: the form ${id} is also in ${entries.find((e) => e.id === id)!.file}.`);
    entries.push({ id, v, at, file: `forms/${f.name}` });
  }
  if (entries.length > 100) throw new Error("There are more than 100 forms; Forms takes up to 100.");
  for (const { id, v, at, file } of entries) {
    if (!ID.test(id)) throw new Error(`${at}: a form id is up to 40 lowercase letters, digits and -, starting with a letter.`);
    if (!isObj(v)) throw new Error(`${at} is a map with name, kind, title, fields or pages, and send_to.`);
    keys(v, at, FORM_KEYS);
    const kind = (v.kind ?? "contact") as Kind;
    if (!["lead", "contact", "nps", "survey"].includes(kind)) throw new Error(`${at}.kind is lead, contact, nps or survey.`);
    const scope: Scope = { before: new Map() };

    const hiddenRaw = v.hidden ?? [];
    if (!Array.isArray(hiddenRaw) || hiddenRaw.length > 30) throw new Error(`${at}.hidden is a list of up to 30 field ids, filled from the page's address.`);
    const hidden = hiddenRaw.map((h, i) => {
      if (typeof h !== "string" || !FIELD_ID.test(h)) throw new Error(`${at}.hidden[${i}] is a field id: lowercase letters, digits and _.`);
      if (scope.before.has(h)) throw new Error(`${at}.hidden: ${h} is in the list twice.`);
      scope.before.set(h, "hidden");
      return h;
    });

    if (v.pages !== undefined && v.fields !== undefined) throw new Error(`${at} has fields (one page) or pages, not both.`);
    const rawPages = v.pages !== undefined ? v.pages : [{ fields: v.fields }];
    if (!Array.isArray(rawPages) || rawPages.length < 1 || rawPages.length > 20) throw new Error(`${at}.pages is a list of 1 to 20 pages.`);
    const pages: PageDef[] = rawPages.map((p, pi) => {
      const pat = v.pages !== undefined ? `${at}.pages[${pi}]` : at;
      if (!isObj(p)) throw new Error(`${pat} is a page: { title, fields, show_if }.`);
      keys(p, pat, ["title", "description", "fields", "show_if"]);
      const showIf = conditions(p.show_if, `${pat}.show_if`, scope);
      if (pi === 0 && showIf.length) throw new Error(`${pat}.show_if: the first page is always shown.`);
      if (!Array.isArray(p.fields) || p.fields.length < 1 || p.fields.length > 50) throw new Error(`${pat}.fields is a list of 1 to 50 fields.`);
      return {
        title: optText(p.title, `${pat}.title`, 200),
        description: optText(p.description, `${pat}.description`, 1000),
        showIf,
        fields: p.fields.map((f, fi) => field(f, `${pat}.fields[${fi}]`, scope)),
      };
    });
    const all = pages.flatMap((p) => p.fields);
    if (all.length > 100) throw new Error(`${at} has more than 100 fields.`);
    if (!all.some((f) => f.type !== "statement")) throw new Error(`${at} asks nothing: it needs a field that takes an answer.`);
    if (kind === "nps" && !all.some((f) => f.type === "nps")) throw new Error(`${at}: an nps form needs a field of type nps.`);

    const of = (t: FieldType) => all.find((f) => f.type === t)?.id ?? null;
    const pr = v.person ?? {};
    if (!isObj(pr)) throw new Error(`${at}.person is a map with email, phone, name, company and user_id: the fields that say who answered.`);
    keys(pr, `${at}.person`, ["email", "phone", "name", "company", "user_id"]);
    const ref = (k: string, fallback: string | null, types: Array<FieldType | "hidden">) => {
      if (pr[k] === undefined) return fallback;
      if (pr[k] === null) return null;
      const t = scope.before.get(String(pr[k]));
      if (!t || !types.includes(t)) throw new Error(`${at}.person.${k}: ${String(pr[k])} is not a ${types.join(" or ")} field of the form.`);
      return String(pr[k]);
    };
    const named = (ids: string[]) => ids.find((x) => ["text", "hidden"].includes(scope.before.get(x) ?? "")) ?? null;
    const person = {
      email: ref("email", of("email"), ["email", "hidden"]),
      phone: ref("phone", of("phone"), ["phone", "hidden"]),
      name: ref("name", named(["name", "full_name"]), ["text", "hidden"]),
      company: ref("company", named(["company"]), ["text", "select", "choice", "hidden"]),
      userId: ref("user_id", hidden.includes("user_id") ? "user_id" : null, ["hidden"]),
    };
    if (all.some((f) => f.type === "consent") && !person.email && !person.phone)
      throw new Error(`${at}: a consent box needs an email or phone field, so Consent knows who agreed.`);

    const embed = v.embed === undefined ? [] : Array.isArray(v.embed) ? v.embed.map((o, i) => origin(o, `${at}.embed[${i}]`)) : [];
    if (v.embed !== undefined && !Array.isArray(v.embed)) throw new Error(`${at}.embed is a list of origins, such as [https://www.example.com].`);

    let redirect: string | null = null;
    let thanks: Text | null = null;
    if (isObj(v.thanks) && ("redirect" in v.thanks || "text" in v.thanks)) {
      keys(v.thanks, `${at}.thanks`, ["text", "redirect"]);
      thanks = optText(v.thanks.text, `${at}.thanks.text`, 2000);
      if (v.thanks.redirect !== undefined) {
        const u = typeof v.thanks.redirect === "string" ? URL.parse(v.thanks.redirect) : null;
        if (!u || u.protocol !== "https:") throw new Error(`${at}.thanks.redirect is an https:// address.`);
        redirect = u.href;
      }
    } else thanks = optText(v.thanks, `${at}.thanks`, 2000);

    let closes: string | null = null;
    if (v.closes !== undefined && v.closes !== null) {
      const s = v.closes instanceof Date ? v.closes.toISOString() : String(v.closes);
      const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59Z` : s);
      if (Number.isNaN(t)) throw new Error(`${at}.closes is a day, such as 2026-12-31, or a time.`);
      closes = new Date(t).toISOString();
    }

    // Where the answers go.
    const st = v.send_to ?? {};
    if (!isObj(st)) throw new Error(`${at}.send_to is a map with audience, crm, helpdesk, notify and webhooks.`);
    keys(st, `${at}.send_to`, ["audience", "crm", "helpdesk", "notify", "webhooks"]);
    let crmSend: CrmSend | null = null;
    if (st.crm !== undefined && st.crm !== false && st.crm !== null) {
      const c = st.crm === true ? {} : st.crm;
      if (!isObj(c)) throw new Error(`${at}.send_to.crm is true, or a map with title, owner, owner_by and value.`);
      keys(c, `${at}.send_to.crm`, ["title", "owner", "owner_by", "value"]);
      let ownerBy: CrmSend["ownerBy"] = null;
      if (c.owner_by !== undefined) {
        const ob = c.owner_by;
        if (!isObj(ob)) throw new Error(`${at}.send_to.crm.owner_by is { field, owners: { <answer>: <member email> } }.`);
        keys(ob, `${at}.send_to.crm.owner_by`, ["field", "owners"]);
        if (!scope.before.has(String(ob.field))) throw new Error(`${at}.send_to.crm.owner_by.field: ${String(ob.field)} is not a field of the form.`);
        if (!isObj(ob.owners) || !Object.keys(ob.owners).length) throw new Error(`${at}.send_to.crm.owner_by.owners maps answers to member emails.`);
        ownerBy = {
          field: String(ob.field),
          owners: Object.fromEntries(Object.entries(ob.owners).map(([k, e]) => [k, email(e, `${at}.send_to.crm.owner_by.owners.${k}`)])),
        };
      }
      const value = c.value === undefined ? null : typeof c.value === "number" && c.value >= 0 ? c.value : NaN;
      if (Number.isNaN(value)) throw new Error(`${at}.send_to.crm.value is the deal's value, 0 or more.`);
      crmSend = {
        title: c.title === undefined ? null : plain(c.title, `${at}.send_to.crm.title`, 120),
        owner: c.owner === undefined ? null : email(c.owner, `${at}.send_to.crm.owner`),
        ownerBy,
        value,
      };
    }
    let helpdeskSend: HelpdeskSend | null = null;
    if (st.helpdesk !== undefined && st.helpdesk !== false && st.helpdesk !== null) {
      const h = st.helpdesk === true ? {} : st.helpdesk;
      if (!isObj(h)) throw new Error(`${at}.send_to.helpdesk is true, or a map with form, subject and message.`);
      keys(h, `${at}.send_to.helpdesk`, ["form", "subject", "message"]);
      if (!person.email) throw new Error(`${at}.send_to.helpdesk: Helpdesk replies by email, so the form needs an email field.`);
      if (h.message !== undefined && !["text", "textarea"].includes(String(scope.before.get(String(h.message)))))
        throw new Error(`${at}.send_to.helpdesk.message: ${String(h.message)} is not a text or textarea field of the form.`);
      helpdeskSend = {
        form: h.form === undefined ? id : plain(h.form, `${at}.send_to.helpdesk.form`, 64),
        subject: h.subject === undefined ? null : plain(h.subject, `${at}.send_to.helpdesk.subject`, 300),
        message: h.message === undefined ? (all.find((f) => f.type === "textarea")?.id ?? null) : String(h.message),
      };
    }
    const notifyRaw = st.notify ?? [];
    const notify = (Array.isArray(notifyRaw) ? notifyRaw : [notifyRaw]).map((e, i) => email(e, `${at}.send_to.notify[${i}]`));
    if (notify.length > 20) throw new Error(`${at}.send_to.notify is up to 20 addresses.`);
    const hooksRaw = st.webhooks ?? [];
    if (!Array.isArray(hooksRaw)) throw new Error(`${at}.send_to.webhooks is a list of webhook ids from webhooks.`);
    const hooks = hooksRaw.map((w, i) => {
      if (!webhooks.some((x) => x.id === w)) throw new Error(`${at}.send_to.webhooks[${i}]: ${String(w)} is not under webhooks.`);
      return String(w);
    });

    const limit = v.limit === undefined || v.limit === null ? null : int(v.limit, `${at}.limit`, 1, 10_000_000);
    forms.push({
      id,
      file,
      name: v.name === undefined ? id : plain(v.name, `${at}.name`, 80),
      kind,
      title: v.title === undefined ? { any: v.name === undefined ? id : String(v.name) } : text(v.title, `${at}.title`, 200),
      description: optText(v.description, `${at}.description`, 2000),
      pages,
      hidden,
      submit: optText(v.submit, `${at}.submit`, 40),
      thanks,
      redirect,
      closed: bool(v.closed, `${at}.closed`, false),
      closes,
      limit,
      closedText: optText(v.closed_text, `${at}.closed_text`, 500),
      embed,
      person,
      spam: spam(v.spam, `${at}.spam`, baseSpam),
      partials: partials(v.partials, `${at}.partials`, basePartials),
      send: { audience: bool(st.audience, `${at}.send_to.audience`, true), crm: crmSend, helpdesk: helpdeskSend, notify, webhooks: hooks },
    });
  }

  return { language, timeZone, forms, keep, mail, analytics, captcha, consent, audience, crm, helpdesk, webhooks };
}

/** Things to fix that do not stop the file from being applied: secrets that are not set, links a form needs. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>): string[] {
  const w: string[] = [];
  const unset = (name: string) => !environment[name];
  if (c.mail && c.mail.user && unset(c.mail.password)) w.push(`mail: ${c.mail.password} is not set, so notifications cannot be sent.`);
  if (c.captcha && unset(c.captcha.secret)) w.push(`captcha: ${c.captcha.secret} is not set, so every answer on a form that asks the captcha is refused.`);
  for (const [k, l] of [
    ["consent", c.consent],
    ["audience", c.audience],
    ["crm", c.crm],
  ] as const)
    if (l && unset(l.token)) w.push(`${k}: ${l.token} is not set, so nothing is sent to ${k[0]!.toUpperCase()}${k.slice(1)}.`);
  if (c.helpdesk && unset(c.helpdesk.key)) w.push(`helpdesk: ${c.helpdesk.key} is not set, so no ticket can be opened.`);
  for (const h of c.webhooks) if (unset(h.secret)) w.push(`webhooks.${h.id}: ${h.secret} is not set, so it is not sent.`);
  for (const f of c.forms) {
    const at = `forms.${f.id}`;
    if (f.send.crm && !c.crm) w.push(`${at}.send_to.crm: crm is not linked in the file, so its answers stay in Forms.`);
    if (f.send.helpdesk && !c.helpdesk) w.push(`${at}.send_to.helpdesk: helpdesk is not linked in the file, so its answers stay in Forms.`);
    if (f.send.notify.length && !c.mail) w.push(`${at}.send_to.notify: there is no mail server under mail, so nobody is told.`);
    if (f.pages.some((p) => p.fields.some((x) => x.type === "consent")) && !c.consent)
      w.push(`${at}: it has a consent box but consent is not linked, so ticked boxes are kept in Forms only.`);
  }
  return w;
}

export interface ConfigFileState {
  path: string;
  appliedAt: string | null;
  error: string | null;
  warnings: string[];
}

/** The form files of the forms folder: every .yaml and .yml in it, by name. A folder that is not there has none. */
function readFolder(dir: string): Array<{ name: string; text: string; stamp: string }> {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => /\.ya?ml$/.test(n))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.map((name) => {
    const st = statSync(join(dir, name));
    return { name, text: readFileSync(join(dir, name), "utf8"), stamp: `${st.size}:${st.mtimeMs}` };
  });
}

/**
 * Reads the file and the forms folder now and whenever one changes (checked every `everyMs`, by size, time and
 * content), and hands each new version, the file's text and the form files to `apply`, which returns warnings or
 * throws to refuse it. What cannot be read or applied leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string, files: Array<{ name: string; text: string }>) => string[],
  { dir = join(dirname(path), "forms"), everyMs = 60_000, onChange }: { dir?: string; everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let files: Array<{ name: string; text: string; stamp: string }>;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      files = readFolder(dir);
      const h = createHash("sha256").update(raw);
      for (const f of files) h.update(`\0${f.name}\0${f.text}`);
      stamp = `${st.size}:${st.mtimeMs}:${files.map((f) => f.stamp).join(",")}:${h.digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path} or ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const list = files.map(({ name, text }) => ({ name, text }));
      state.warnings = apply(parseConfig(raw, list, basename(path)), raw, list);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
