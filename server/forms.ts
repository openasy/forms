// Forms: the forms of the file served to pages, the answers they send (checked again here, filtered for spam, kept),
// what is kept of answers not sent, the files people attach, where each answer goes (Consent, Audience, CRM, Helpdesk,
// email, webhooks, through an outbox tried again until taken), the members' views of the answers, and deletion on
// request.
import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { configWarnings, formLanguages, LANGS, pick, type Config, type ConfigFileState, type FieldDef, type FormDef, type Lang, type Text } from "./config.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { toCsv } from "./csv.ts";
import {
  CAPTCHA_VERIFY,
  consentPurposes,
  LinkError,
  openLead,
  openTicket,
  recordConsent,
  sendToAudience,
  sendWebhook,
  verifyCaptcha,
  type AudienceEvent,
  type ConsentPurpose,
  type ConsentRecord,
  type CrmLead,
  type HelpdeskTicket,
  type Mail,
  type Mailer,
} from "./links.ts";
import { display, shown, validate, type Answers, type ErrorCode, type PublicField, type PublicForm, type PublicPage, type Value } from "./logic.ts";
import { sniff } from "./sniff.ts";
import { createLimiter, createTokens, tokenHash, workDone } from "./spam.ts";
import { bad, body, createStore, DAY, FormsError, isObj, MINUTE, notFound, phoneKey, type Actor } from "./store.ts";

export interface FormsOptions {
  /** The address people open Forms at; the form pages, the embed and links in emails use it. */
  publicUrl: string;
  /** Signs the pages' tokens: derived from the product's key, or random for this process. */
  tokenKey: Buffer;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  fetch?: typeof fetch;
  /** The mail server for the file's mail; tests pass one that keeps what it is given. */
  mailer?: (c: Config) => Mailer | null;
  captchaEndpoints?: { turnstile: string; hcaptcha: string };
  fileState?: () => ConfigFileState | null;
}

type Status = "partial" | "submitted" | "spam";
type Target = "consent" | "audience" | "crm" | "helpdesk" | "mail" | "webhook";
export const TARGETS: Target[] = ["consent", "audience", "crm", "helpdesk", "mail", "webhook"];

interface ResponseRow {
  id: string;
  form: string;
  status: Status;
  token_hash: string;
  language: string;
  page: number;
  pages: string;
  answered: string;
  answers: string | null;
  meta: string;
  email: string | null;
  phone: string | null;
  phone_key: string | null;
  name: string | null;
  company: string | null;
  user_id: string | null;
  nps: number | null;
  spam_reason: string | null;
  started_at: string;
  updated_at: string;
  submitted_at: string | null;
}

interface DeliveryRow {
  id: number;
  response_id: string;
  target: Target;
  name: string | null;
  state: "waiting" | "sent" | "failed";
  payload: string;
  attempts: number;
  next_at: string;
  error: string | null;
  result: string | null;
  created_at: string;
  done_at: string | null;
}

interface FileRow {
  id: string;
  form: string;
  field: string;
  token_hash: string;
  response_id: string | null;
  name: string;
  type: string;
  size: number;
  data: Uint8Array;
  created_at: string;
}

interface Meta {
  url?: string | null;
  referrer?: string | null;
  utm?: { source: string | null; medium: string | null; campaign: string | null } | null;
  origin?: string | null;
  hidden?: Record<string, string>;
}

const newId = () => randomBytes(12).toString("base64url");
const parse = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const fieldsOf = (f: FormDef) => f.pages.flatMap((p) => p.fields);
const MESSAGES: Record<ErrorCode, string> = {
  required: "This is required.",
  too_short: "This is too short.",
  too_long: "This is too long.",
  too_small: "This is too small.",
  too_large: "This is too large.",
  pattern: "This is not in the form asked for.",
  email: "This is not an email address.",
  phone: "This is not a phone number.",
  url: "This is not a web address.",
  date: "This is not a day.",
  number: "This is not a number.",
  option: "This is not one of the options.",
  too_few: "Too few are ticked.",
  too_many: "Too many are ticked.",
  file: "The file is missing; attach it again.",
};

/** The language of a page: ?lang=, else the first of the browser's the form is written in, else the file's. */
export function pickLang(accept: string | undefined, asked: string | null, offered: Lang[], fallback: Lang): Lang {
  const ok = (l: string) => offered.find((x) => x === l.toLowerCase().slice(0, 2));
  if (asked && ok(asked)) return ok(asked)!;
  for (const part of (accept ?? "").split(",")) {
    const l = ok(part.trim().split(";")[0] ?? "");
    if (l) return l;
  }
  return offered.includes(fallback) ? fallback : offered[0]!;
}

/** The first moment of a day in a time zone, as epoch milliseconds. */
export function dayStart(day: string, timeZone: string): number {
  const utc = Date.parse(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utc);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return utc - (local - utc);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createForms(db: DatabaseSync, opts: FormsOptions) {
  const clock = opts.clock ?? Date.now;
  const env = opts.env ?? process.env;
  const f = opts.fetch ?? fetch;
  const { q, one, run, tx, iso } = createStore(db, clock);
  const tokens = createTokens(opts.tokenKey, clock);
  const limiter = createLimiter(clock);
  const captchaEndpoints = opts.captchaEndpoints ?? CAPTCHA_VERIFY;
  let config: Config | null = null;
  let yaml = "";
  /** The text of each form file of the forms folder, by its path (forms/demo.yaml), for the form's page in the UI. */
  let formFiles = new Map<string, string>();
  let purposes = new Map<string, ConsentPurpose>();
  let purposesAt = 0;
  let purposesError: string | null = null;
  let mailer: Mailer | null = null;
  let chain: Promise<void> = Promise.resolve();
  let queued = false;
  let lastSweep = 0;
  const counters = {
    responses: new Map<string, number>(),
    deliveries: new Map<string, number>(),
  };
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const cfg = () => {
    if (!config) throw new FormsError(503, "internal-error", "The settings file has not been applied yet.");
    return config;
  };
  const formDef = (id: string) => {
    const d = cfg().forms.find((x) => x.id === id);
    if (!d) throw notFound(`The form ${id}`);
    return d;
  };

  function setConfig(c: Config, text: string, files: Array<{ name: string; text: string }> = []): string[] {
    const before = config;
    config = c;
    yaml = text;
    formFiles = new Map(files.map((f) => [`forms/${f.name}`, f.text]));
    if (!before || JSON.stringify(before.mail) !== JSON.stringify(c.mail)) {
      mailer?.close();
      mailer = opts.mailer ? opts.mailer(c) : null;
    }
    if (JSON.stringify(before?.consent) !== JSON.stringify(c.consent)) purposesAt = 0;
    return configWarnings(c, env);
  }

  // ---------------------------------------------------------------- the form as a page shows it

  const t = (x: Text | null, lang: Lang) => (x ? pick(x, lang, cfg().language) : null);

  function consentText(fd: FieldDef, lang: Lang): { text: string; version: number | null } {
    const p = fd.consent && cfg().consent ? purposes.get(fd.consent.purpose) : undefined;
    if (!p) return { text: t(fd.label, lang)!, version: null };
    const text = typeof p.text === "string" ? p.text : (p.text[lang] ?? p.text[cfg().language] ?? p.text.en ?? Object.values(p.text)[0] ?? t(fd.label, lang)!);
    return { text, version: p.current };
  }

  function publicField(fd: FieldDef, lang: Lang): PublicField {
    const c = fd.type === "consent" ? consentText(fd, lang) : null;
    return {
      id: fd.id,
      type: fd.type,
      label: c ? c.text : t(fd.label, lang)!,
      help: t(fd.help, lang),
      placeholder: t(fd.placeholder, lang),
      required: fd.required,
      min: fd.min,
      max: fd.max,
      pattern: fd.pattern,
      patternMessage: t(fd.patternMessage, lang),
      options: fd.options.map((o) => ({ value: o.value, label: t(o.label, lang)! })),
      minLabel: t(fd.minLabel, lang),
      maxLabel: t(fd.maxLabel, lang),
      accept: fd.accept,
      maxSize: fd.maxSize,
      consent: fd.consent && c ? { purpose: fd.consent.purpose, channels: fd.consent.channels, version: c.version } : null,
      showIf: fd.showIf,
    };
  }

  function pagesOf(d: FormDef, lang: Lang): PublicPage[] {
    return d.pages.map((p) => ({
      title: t(p.title, lang),
      description: t(p.description, lang),
      showIf: p.showIf,
      fields: p.fields.map((x) => publicField(x, lang)),
    }));
  }

  function closedState(d: FormDef): PublicForm["closed"] {
    if (d.closed || (d.closes && Date.parse(d.closes) <= clock())) return "closed";
    if (d.limit !== null) {
      const n = one<{ n: number }>("SELECT COUNT(*) AS n FROM responses WHERE form = ? AND status = 'submitted'", d.id)!.n;
      if (n >= d.limit) return "full";
    }
    return null;
  }

  /** Counts a view of the form: a number by day, nothing about who saw it. */
  function countView(id: string) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: cfg().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(clock());
    run("INSERT INTO views (form, day, n) VALUES (?, ?, 1) ON CONFLICT (form, day) DO UPDATE SET n = n + 1", id, day);
  }

  function publicForm(id: string, lang: Lang, count = false): PublicForm {
    const d = formDef(id);
    const c = cfg();
    if (count) countView(d.id);
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      language: lang,
      title: t(d.title, lang)!,
      description: t(d.description, lang),
      pages: pagesOf(d, lang),
      hidden: d.hidden,
      submit: t(d.submit, lang) ?? "",
      thanks: t(d.thanks, lang) ?? "",
      redirect: d.redirect,
      closed: closedState(d),
      closedText: t(d.closedText, lang),
      token: tokens.issue(d.id),
      spam: {
        honeypot: "website",
        proofOfWork: d.spam.proofOfWork,
        captcha: d.spam.captcha && c.captcha ? { provider: c.captcha.provider, siteKey: c.captcha.siteKey } : null,
      },
      partials: d.partials,
      endpoint: opts.publicUrl,
    };
  }

  /** The languages a form is written in, and the page's. */
  const languages = (id: string) => formLanguages(formDef(id), cfg().language);

  // ---------------------------------------------------------------- what pages send

  function rate(kind: string, form: string, address: string, n: number, perMs: number) {
    const wait = limiter.take(`${kind}:${form}`, address, n, perMs);
    if (wait !== null) throw new FormsError(429, "rate-limited", "Too many answers from this address; wait a little.", { retryAfter: wait });
  }

  function readToken(d: FormDef, token: unknown) {
    const r = tokens.read(d.id, token);
    if ("error" in r) {
      if (r.error === "expired") throw new FormsError(422, "expired", "The page was open too long; load it again.");
      throw new FormsError(422, "invalid-token", "The token is not one this form gave.");
    }
    return { issued: r.issued, hash: tokenHash(token as string) };
  }

  const cleanText = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

  function readMeta(raw: unknown, origin: string | undefined): Meta {
    const m = isObj(raw) ? raw : {};
    const url = cleanText(m.url, 2000);
    const u = url ? URL.parse(url) : null;
    const utm = u ? { source: u.searchParams.get("utm_source"), medium: u.searchParams.get("utm_medium"), campaign: u.searchParams.get("utm_campaign") } : null;
    return {
      // The query string can hold what people typed elsewhere; only utm_* are kept from it.
      url: u ? `${u.origin}${u.pathname}` : null,
      referrer: cleanText(m.referrer, 2000)?.split(/[?#]/)[0] ?? null,
      utm: utm && (utm.source || utm.medium || utm.campaign) ? utm : null,
      origin: origin && origin !== "null" ? origin.slice(0, 200) : null,
    };
  }

  function person(d: FormDef, a: Answers) {
    const s = (k: string | null) => (k && typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim().slice(0, 254) : null);
    const email = s(d.person.email)?.toLowerCase() ?? null;
    return {
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      phone: s(d.person.phone),
      name: s(d.person.name),
      company: s(d.person.company),
      userId: s(d.person.userId),
    };
  }

  const view = (d: FormDef) => ({ pages: pagesOf(d, cfg().language), hidden: d.hidden });

  /** A page's answer. Returns the response's id; a bot gets the same answer as a person and is kept as spam. */
  async function submit(id: string, raw: unknown, ctx: { address: string; origin?: string }) {
    const d = formDef(id);
    const b = body(raw, ["token", "answers", "language", "page", "website", "proof", "captcha", "versions"]);
    rate("submit", d.id, ctx.address, d.spam.rate.n, d.spam.rate.perMs);
    if (closedState(d)) throw new FormsError(409, "closed", "The form takes no more answers.");
    const tk = readToken(d, b.token);
    const answer = (r: { id: string }) => ({ response: { id: r.id }, thanks: t(d.thanks, langOf(b.language, d)) ?? "", redirect: redirectFor(d, r.id) });
    const seen = one<ResponseRow>("SELECT * FROM responses WHERE token_hash = ?", tk.hash);
    if (seen && seen.status !== "partial") return { status: 200, body: answer(seen) };
    if (!isObj(b.answers)) throw bad("answers is a map of field ids to answers.");
    const lang = langOf(b.language, d);
    const meta = readMeta(b.page, ctx.origin);

    // The hidden field and the time: a bot's answer is kept as spam and answered as if it were taken.
    let spamReason: string | null = null;
    if (typeof b.website === "string" && b.website.trim()) spamReason = "honeypot";
    else if (clock() - tk.issued < d.spam.minSeconds * 1000) spamReason = "too_fast";
    if (!spamReason && d.spam.proofOfWork !== null && !workDone(b.token as string, b.proof, d.spam.proofOfWork))
      throw new FormsError(422, "proof-of-work", "The page's proof of work is missing or wrong; load the page again.");
    const c = cfg();
    if (!spamReason && d.spam.captcha && c.captcha) {
      let good = false;
      try {
        good = await verifyCaptcha(f, captchaEndpoints[c.captcha.provider], env[c.captcha.secret], b.captcha, c.captcha.siteKey);
      } catch (err) {
        if (!(err instanceof LinkError)) throw err;
        throw new FormsError(503, "captcha-failed", "The captcha could not be checked; try again in a moment.", { retryAfter: 30 });
      }
      if (!good) throw new FormsError(422, "captcha-failed", "The captcha was not solved; try it again.");
    }

    const v = view(d);
    const given = { ...(b.answers as Answers) };
    const { answers, errors } = validate(v, given);
    if (errors.length && !spamReason)
      throw new FormsError(422, "invalid-answers", "Some answers need a change.", { errors: errors.map((e) => ({ ...e, message: MESSAGES[e.code] })) });
    const s = shown(v, answers);

    // Files must have been sent with this page view, to this field.
    const files = s.fields.filter((x) => x.type === "file" && typeof answers[x.id] === "string");
    for (const x of files) {
      const fr = one<FileRow>("SELECT id, form, field, token_hash, response_id FROM files WHERE id = ?", answers[x.id] as string);
      if (!fr || fr.form !== d.id || fr.field !== x.id || fr.token_hash !== tk.hash || (fr.response_id && fr.response_id !== seen?.id)) {
        if (spamReason) delete answers[x.id];
        else throw new FormsError(422, "invalid-answers", "Some answers need a change.", { errors: [{ field: x.id, code: "file", message: MESSAGES.file }] });
      }
    }

    const who = person(d, answers);
    const nps = s.fields.find((x) => x.type === "nps");
    const npsValue = nps && typeof answers[nps.id] === "number" ? (answers[nps.id] as number) : null;
    const hidden: Record<string, string> = {};
    for (const h of d.hidden) if (typeof answers[h] === "string") hidden[h] = answers[h] as string;
    const now = iso();
    const versions = isObj(b.versions) ? b.versions : {};
    const rid = seen?.id ?? newId();
    tx(() => {
      const values = [
        spamReason ? "spam" : "submitted",
        lang,
        s.pages.at(-1) ?? 0,
        JSON.stringify(s.pages),
        JSON.stringify(Object.keys(answers).filter((k) => !d.hidden.includes(k))),
        JSON.stringify(answers),
        JSON.stringify({ ...meta, hidden }),
        who.email,
        who.phone,
        phoneKey(who.phone),
        who.name,
        who.company,
        who.userId,
        npsValue,
        spamReason,
        now,
        now,
      ] as SQLInputValue[];
      if (seen)
        run(
          `UPDATE responses SET status = ?, language = ?, page = ?, pages = ?, answered = ?, answers = ?, meta = ?, email = ?, phone = ?, phone_key = ?,
             name = ?, company = ?, user_id = ?, nps = ?, spam_reason = ?, updated_at = ?, submitted_at = ? WHERE id = ?`,
          ...values,
          rid,
        );
      else
        run(
          `INSERT INTO responses (status, language, page, pages, answered, answers, meta, email, phone, phone_key, name, company, user_id, nps, spam_reason,
             updated_at, submitted_at, id, form, token_hash, started_at) VALUES (${Array(21).fill("?").join(", ")})`,
          ...values,
          rid,
          d.id,
          tk.hash,
          new Date(tk.issued).toISOString(),
        );
      for (const x of files) if (answers[x.id]) run("UPDATE files SET response_id = ? WHERE id = ?", rid, answers[x.id] as string);
      if (!spamReason) enqueue(d, mustResponse(rid), versions);
    });
    count(counters.responses, `${d.id}:${spamReason ? "spam" : "submitted"}`);
    queueMicrotask(() => void flush());
    return { status: 201, body: answer({ id: rid }) };
  }

  function langOf(raw: unknown, d: FormDef): Lang {
    const offered = formLanguages(d, cfg().language);
    return typeof raw === "string" && (offered as string[]).includes(raw) ? (raw as Lang) : offered.includes(cfg().language) ? cfg().language : offered[0]!;
  }

  function redirectFor(d: FormDef, rid: string): string | null {
    if (!d.redirect) return null;
    const u = new URL(d.redirect);
    u.searchParams.set("response", rid);
    return u.href;
  }

  /** How far a page got before it was sent: kept as the form's partials setting says. */
  function progress(id: string, raw: unknown, ctx: { address: string; origin?: string }): void {
    const d = formDef(id);
    const b = body(raw, ["token", "answers", "answered", "pages", "language", "page"]);
    rate("progress", d.id, ctx.address, 120, MINUTE);
    if (d.partials === "off") return;
    const tk = readToken(d, b.token);
    const seen = one<ResponseRow>("SELECT * FROM responses WHERE token_hash = ?", tk.hash);
    if (seen && seen.status !== "partial") return;
    const page = typeof b.page === "number" && Number.isInteger(b.page) && b.page >= 0 && b.page < d.pages.length ? b.page : 0;
    const furthest = Math.max(page, seen?.page ?? 0);
    const all = fieldsOf(d);
    const pageOf = (fid: string) => d.pages.findIndex((p) => p.fields.some((x) => x.id === fid));
    let kept: Answers = {};
    let answeredIds: string[];
    let reachedNow: number[];
    if (d.partials === "answers") {
      // Only valid answers on the pages shown up to this one; files and consent boxes are never kept with a partial.
      const v = view(d);
      const { answers } = validate(v, isObj(b.answers) ? (b.answers as Answers) : {}, page);
      const s = shown(v, answers);
      for (const fd of s.fields)
        if (fd.type !== "file" && fd.type !== "consent" && answers[fd.id] !== undefined && pageOf(fd.id) <= page) kept[fd.id] = answers[fd.id]!;
      answeredIds = Object.keys(kept);
      reachedNow = s.pages.filter((p) => p <= page);
    } else {
      // Only which fields were answered and which pages reached: no value is sent or kept.
      const ids = Array.isArray(b.answered) ? b.answered.filter((x): x is string => typeof x === "string") : [];
      answeredIds = all.filter((x) => ids.includes(x.id) && x.type !== "statement" && pageOf(x.id) <= page).map((x) => x.id);
      const ps = Array.isArray(b.pages) ? b.pages.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= page) : [];
      reachedNow = [...new Set([0, ...ps, page])];
      kept = {};
    }
    const who = d.partials === "answers" ? person(d, kept) : { email: null, phone: null, name: null, company: null, userId: null };
    const reached = [...new Set([...parse<number[]>(seen?.pages ?? "[]", []), ...reachedNow])].sort((x, y) => x - y);
    const now = iso();
    const stored = d.partials === "answers" ? JSON.stringify(kept) : null;
    const merged = [...new Set([...parse<string[]>(seen?.answered ?? "[]", []).filter(() => d.partials !== "answers"), ...answeredIds])];
    if (seen)
      run(
        "UPDATE responses SET page = ?, pages = ?, answered = ?, answers = ?, email = ?, phone = ?, phone_key = ?, name = ?, company = ?, language = ?, updated_at = ? WHERE id = ?",
        furthest,
        JSON.stringify(reached),
        JSON.stringify(merged),
        stored,
        who.email,
        who.phone,
        phoneKey(who.phone),
        who.name,
        who.company,
        langOf(b.language, d),
        now,
        seen.id,
      );
    else {
      run(
        `INSERT INTO responses (id, form, status, token_hash, language, page, pages, answered, answers, meta, email, phone, phone_key, name, company, started_at, updated_at)
         VALUES (?, ?, 'partial', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        d.id,
        tk.hash,
        langOf(b.language, d),
        furthest,
        JSON.stringify(reached),
        JSON.stringify(merged),
        stored,
        JSON.stringify(readMeta({}, ctx.origin)),
        who.email,
        who.phone,
        phoneKey(who.phone),
        who.name,
        who.company,
        new Date(tk.issued).toISOString(),
        now,
      );
      count(counters.responses, `${d.id}:partial`);
    }
  }

  /** A file for a file field, before the answer is sent. Its bytes must be one of the types the field takes. */
  function upload(id: string, params: URLSearchParams, data: Buffer, name: string | undefined, ctx: { address: string }) {
    const d = formDef(id);
    rate("file", d.id, ctx.address, 20, MINUTE);
    const tk = readToken(d, params.get("token"));
    const fd = fieldsOf(d).find((x) => x.id === params.get("field") && x.type === "file");
    if (!fd) throw bad("field is the id of a file field of the form.");
    if (data.length > fd.maxSize!) throw new FormsError(413, "payload-too-large", `The file must be at most ${Math.round(fd.maxSize! / 1024)} KiB.`);
    if (!data.length) throw bad("The file is empty.");
    const type = sniff(data);
    if (!type || !fd.accept.includes(type))
      throw new FormsError(415, "unsupported-file", `This field takes ${fd.accept.join(", ")}; the file is ${type ?? "of another type"}.`);
    const loose = one<{ n: number }>("SELECT COUNT(*) AS n FROM files WHERE token_hash = ? AND response_id IS NULL", tk.hash)!.n;
    if (loose >= 20) throw new FormsError(429, "rate-limited", "Too many files for one answer.", { retryAfter: 60 });
    const clean =
      (name ?? "file")
        .replace(/[\u0000-\u001f\u007f/\\]/g, "")
        .trim()
        .slice(0, 200) || "file";
    const fid = newId();
    run(
      "INSERT INTO files (id, form, field, token_hash, name, type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      fid,
      d.id,
      fd.id,
      tk.hash,
      clean,
      type,
      data.length,
      data,
      iso(),
    );
    return { id: fid, name: clean, size: data.length, type };
  }

  // ---------------------------------------------------------------- where answers go

  function mustResponse(id: string) {
    const r = one<ResponseRow>("SELECT * FROM responses WHERE id = ?", id);
    if (!r) throw notFound("The answer");
    return r;
  }

  /** The answers with their questions, in the file's language, for emails, CRM and Helpdesk. */
  function lines(d: FormDef, a: Answers, skip: string[] = []) {
    const lang = cfg().language;
    const out: Array<{ id: string; label: string; text: string; value: Value }> = [];
    for (const fd of fieldsOf(d)) {
      if (fd.type === "statement" || a[fd.id] === undefined || skip.includes(fd.id)) continue;
      const pf = publicField(fd, lang);
      let text = display(pf, a[fd.id], "Yes", "No");
      if (fd.type === "file") text = one<{ name: string }>("SELECT name FROM files WHERE id = ?", String(a[fd.id]))?.name ?? text;
      if (fd.type === "consent") text = "Yes";
      out.push({ id: fd.id, label: fd.type === "consent" ? `${pick(fd.label, lang, lang)} (consent)` : pf.label, text, value: a[fd.id]! });
    }
    for (const h of d.hidden) if (a[h] !== undefined && !skip.includes(h)) out.push({ id: h, label: h, text: String(a[h]), value: a[h]! });
    return out;
  }

  const fill = (template: string, d: FormDef, a: Answers) =>
    template
      .replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k: string) => lines(d, a).find((l) => l.id === k)?.text ?? "")
      .replace(/\s+/g, " ")
      .trim();

  function enqueue(d: FormDef, r: ResponseRow, versions: Record<string, unknown>) {
    const c = cfg();
    const a = parse<Answers>(r.answers, {});
    const meta = parse<Meta>(r.meta, {});
    const at = r.submitted_at ?? iso();
    const add = (target: Target, payload: unknown, name: string | null = null) =>
      run(
        "INSERT INTO deliveries (response_id, target, name, state, payload, next_at, created_at) VALUES (?, ?, ?, 'waiting', ?, ?, ?)",
        r.id,
        target,
        name,
        JSON.stringify(payload),
        at,
        iso(),
      );
    const ls = lines(d, a);
    const listText = ls.map((l) => `${l.label}: ${l.text}`).join("\n");

    // Consent: each ticked box, per channel, with the version of the text the page showed.
    const ticked = fieldsOf(d).filter((x) => x.type === "consent" && a[x.id] === true);
    if (c.consent && ticked.length && (r.email || r.phone)) {
      const rec: ConsentRecord = {
        person: { ...(r.email && { email: r.email }), ...(r.phone && { phone: r.phone }), ...(r.user_id && { id: r.user_id }) },
        answers: ticked.flatMap((x) => {
          const p = purposes.get(x.consent!.purpose);
          const asked = versions[x.id];
          const version = typeof asked === "number" && Number.isInteger(asked) && asked >= 1 && (!p || asked <= p.current) ? asked : p?.current;
          const shownText = consentText(x, r.language as Lang).text;
          return x.consent!.channels.map((channel) => ({
            purpose: x.consent!.purpose,
            channel,
            granted: true as const,
            ...(version !== undefined && { version }),
            at,
            proof: `${d.name} (forms/${d.id}), answer ${r.id}: ${shownText}`.slice(0, 500),
          }));
        }),
        source: "form",
        via: `forms/${d.id}`.slice(0, 128),
      };
      add("consent", rec);
    }

    // Audience: a form_submitted event for the person.
    if (c.audience && d.send.audience && (r.email || r.phone || r.user_id)) {
      const traits: Record<string, string | number | boolean> = {};
      for (const x of fieldsOf(d)) {
        const v = a[x.id];
        if (x.trait && v !== undefined) traits[x.trait] = Array.isArray(v) ? v.join(", ") : v;
      }
      const ev: AudienceEvent = {
        source: "forms",
        type: "form_submitted",
        id: `forms:${r.id}`,
        at,
        person: { email: r.email, phone: r.phone, userId: r.user_id, name: r.name },
        ...(Object.keys(traits).length && { traits }),
        properties: { form: d.id, form_name: d.name, kind: d.kind, ...(r.nps !== null && { nps: r.nps }), ...(meta.url && { page: meta.url }) },
        text: `Sent the form ${d.name}`.slice(0, 300),
      };
      add("audience", ev);
    }

    // CRM: a lead with a deal.
    if (c.crm && d.send.crm) {
      const s = d.send.crm;
      const byAnswer = s.ownerBy ? s.ownerBy.owners[String(a[s.ownerBy.field] ?? "")] : undefined;
      const owner = byAnswer ?? s.owner;
      const lead: CrmLead = {
        external_id: `forms-${r.id}`,
        source: "forms",
        title: (s.title ? fill(s.title, d, a) : "") || `${d.name}${r.company ? `: ${r.company}` : r.name ? `: ${r.name}` : ""}`.slice(0, 120),
        name: r.name,
        email: r.email,
        phone: r.phone,
        company: r.company,
        page: meta.url ?? null,
        referrer: meta.referrer ?? null,
        utm: meta.utm ?? null,
        ...(owner && { owner: { email: owner } }),
        ...(s.value !== null && { value: s.value }),
        message: `${d.name}\n${listText}`.slice(0, 5000),
      };
      add("crm", lead);
    }

    // Helpdesk: a ticket from the person's email.
    if (c.helpdesk && d.send.helpdesk && r.email) {
      const h = d.send.helpdesk;
      const message = (h.message && typeof a[h.message] === "string" ? (a[h.message] as string) : "") || listText || d.name;
      const skip = [h.message, d.person.email, d.person.name].filter((x): x is string => !!x);
      const fields: Record<string, string | number | boolean> = {};
      for (const l of lines(d, a, skip).slice(0, 50))
        fields[l.label.slice(0, 100)] = typeof l.value === "number" || typeof l.value === "boolean" ? l.value : l.text;
      const ticket: HelpdeskTicket = {
        email: r.email,
        ...(r.name && { name: r.name.slice(0, 200) }),
        subject: (h.subject ? fill(h.subject, d, a) : d.name).slice(0, 300),
        message: message.slice(0, 50_000),
        form: h.form,
        ...(Object.keys(fields).length && { fields }),
        language: r.language,
        external_id: `forms-${r.id}`,
      };
      add("helpdesk", ticket);
    }

    // Email to the people the form names.
    if (c.mail && d.send.notify.length) {
      const mail: Mail = {
        to: d.send.notify,
        subject: `New answer to ${d.name}${r.name ? ` from ${r.name}` : ""}`.slice(0, 200),
        text: `${listText}\n\n${meta.url ? `Sent from ${meta.url}\n` : ""}Open it in Forms: ${opts.publicUrl}/responses/${r.id}\n`,
        ...(r.email && { replyTo: r.email }),
      };
      add("mail", mail);
    }

    // Webhooks.
    for (const name of d.send.webhooks) {
      const filesOf = q<{ id: string; field: string; name: string; type: string; size: number }>(
        "SELECT id, field, name, type, size FROM files WHERE response_id = ?",
        r.id,
      );
      add(
        "webhook",
        {
          type: "response.submitted",
          timestamp: at,
          data: {
            id: r.id,
            form: { id: d.id, name: d.name, kind: d.kind },
            submittedAt: at,
            language: r.language,
            answers: a,
            fields: ls.map((l) => ({ id: l.id, label: l.label, value: l.value, text: l.text })),
            person: { email: r.email, phone: r.phone, name: r.name, company: r.company },
            page: { url: meta.url ?? null, referrer: meta.referrer ?? null, utm: meta.utm ?? null },
            files: filesOf.map((x) => ({ ...x, url: `${opts.publicUrl}/api/v1/files/${x.id}` })),
            url: `${opts.publicUrl}/responses/${r.id}`,
          },
        },
        name,
      );
    }
  }

  async function deliver(d: DeliveryRow): Promise<unknown> {
    const c = cfg();
    const p = JSON.parse(d.payload) as Record<string, unknown>;
    const gone = (what: string) => new LinkError(`${what} is not linked in the file any more.`, null, true);
    switch (d.target) {
      case "consent":
        if (!c.consent) throw gone("Consent");
        return recordConsent(f, c.consent.url, env[c.consent.token], p as unknown as ConsentRecord);
      case "audience":
        if (!c.audience) throw gone("Audience");
        return sendToAudience(f, c.audience.url, env[c.audience.token], p as unknown as AudienceEvent);
      case "crm":
        if (!c.crm) throw gone("CRM");
        return openLead(f, c.crm.url, env[c.crm.token], p as unknown as CrmLead);
      case "helpdesk":
        if (!c.helpdesk) throw gone("Helpdesk");
        return openTicket(f, c.helpdesk.url, env[c.helpdesk.key], p as unknown as HelpdeskTicket);
      case "mail":
        if (!mailer) throw gone("A mail server");
        try {
          await mailer.send(p as unknown as Mail);
        } catch (err) {
          const code = (err as { responseCode?: number }).responseCode;
          throw new LinkError(`The mail server: ${(err as Error).message}`, code ?? null, !!code && code >= 500 && code < 600);
        }
        return { to: (p.to as string[]).length };
      case "webhook": {
        const w = c.webhooks.find((x) => x.id === d.name);
        if (!w) throw gone(`The webhook ${d.name}`);
        const ts = Math.floor(clock() / 1000);
        return sendWebhook(f, w.url, env[w.secret], `forms-${d.id}`, ts, JSON.stringify(p));
      }
    }
  }

  /** Sends what is due. A failure is tried again after 1, 2, 4 minutes and so on up to 6 hours, for three days. */
  function flush(): Promise<void> {
    // One round at a time; a call while one runs waits for it and runs again, so what it added is sent too.
    if (queued) return chain;
    queued = true;
    chain = chain.then(() => {
      queued = false;
      return flushOnce();
    });
    return chain;
  }

  async function flushOnce() {
    if (!config) return;
    {
      for (let round = 0; round < 10; round++) {
        const due = q<DeliveryRow>("SELECT * FROM deliveries WHERE state = 'waiting' AND next_at <= ? ORDER BY id LIMIT 25", iso());
        if (!due.length) break;
        for (const d of due) {
          try {
            const result = await deliver(d);
            run(
              "UPDATE deliveries SET state = 'sent', attempts = attempts + 1, error = NULL, result = ?, done_at = ? WHERE id = ?",
              JSON.stringify(result ?? {}),
              iso(),
              d.id,
            );
            count(counters.deliveries, `${d.target}:sent`);
          } catch (err) {
            if (!(err instanceof LinkError)) throw err;
            const attempts = d.attempts + 1;
            const old = clock() - Date.parse(d.created_at) > 3 * DAY;
            if (err.permanent || old) {
              run(
                "UPDATE deliveries SET state = 'failed', attempts = ?, error = ?, done_at = ? WHERE id = ?",
                attempts,
                old && !err.permanent ? `${err.message} (tried for three days)` : err.message,
                iso(),
                d.id,
              );
              count(counters.deliveries, `${d.target}:failed`);
            } else {
              const wait = Math.min(2 ** (attempts - 1) * MINUTE, 6 * 60 * MINUTE);
              run("UPDATE deliveries SET attempts = ?, error = ?, next_at = ? WHERE id = ?", attempts, err.message, iso(clock() + wait), d.id);
              count(counters.deliveries, `${d.target}:retry`);
            }
          }
        }
      }
    }
  }

  async function refreshPurposes(force = false) {
    const c = config?.consent;
    if (!c) {
      purposes = new Map();
      return;
    }
    if (!force && clock() - purposesAt < 5 * MINUTE) return;
    purposesAt = clock();
    try {
      purposes = new Map((await consentPurposes(f, c.url, env[c.token])).map((p) => [p.id, p]));
      purposesError = null;
    } catch (err) {
      if (!(err instanceof LinkError)) throw err;
      purposesError = err.message;
    }
  }

  /** What is kept no longer: partials, spam and files nobody sent, and answers past keep.responses. */
  function sweep() {
    const c = config;
    if (!c) return;
    run("DELETE FROM responses WHERE status = 'partial' AND updated_at < ?", iso(clock() - c.keep.partialDays * DAY));
    run("DELETE FROM responses WHERE status = 'spam' AND updated_at < ?", iso(clock() - c.keep.spamDays * DAY));
    if (c.keep.responseDays !== null) run("DELETE FROM responses WHERE status = 'submitted' AND submitted_at < ?", iso(clock() - c.keep.responseDays * DAY));
    run("DELETE FROM files WHERE response_id IS NULL AND created_at < ?", iso(clock() - DAY));
  }

  async function tick() {
    await refreshPurposes();
    if (clock() - lastSweep > 10 * MINUTE) {
      lastSweep = clock();
      sweep();
    }
    await flush();
  }

  // ---------------------------------------------------------------- what members see

  function deliveriesOf(rid: string) {
    return q<DeliveryRow>("SELECT * FROM deliveries WHERE response_id = ? ORDER BY id", rid).map((d) => ({
      id: d.id,
      target: d.target,
      name: d.name,
      state: d.state,
      attempts: d.attempts,
      error: d.error,
      result: parse<Record<string, unknown> | null>(d.result, null),
      nextAt: d.state === "waiting" ? d.next_at : null,
      createdAt: d.created_at,
      doneAt: d.done_at,
    }));
  }

  function answersOf(d: FormDef | undefined, r: ResponseRow) {
    const a = parse<Answers | null>(r.answers, null);
    if (!a) return null;
    const lang = cfg().language;
    const out: Array<{
      field: string;
      label: string;
      type: string;
      value: Value;
      text: string;
      file?: { id: string; name: string; size: number; type: string };
    }> = [];
    for (const fd of d ? fieldsOf(d) : []) {
      if (a[fd.id] === undefined || fd.type === "statement") continue;
      const pf = publicField(fd, lang);
      const item: (typeof out)[number] = { field: fd.id, label: pf.label, type: fd.type, value: a[fd.id]!, text: display(pf, a[fd.id]) };
      if (fd.type === "file") {
        const file = one<{ id: string; name: string; size: number; type: string }>("SELECT id, name, size, type FROM files WHERE id = ?", String(a[fd.id]));
        if (file) ((item.file = file), (item.text = file.name));
      }
      out.push(item);
    }
    // Answers to fields no longer in the file are still shown, by their id.
    const known = new Set([...(d ? fieldsOf(d).map((x) => x.id) : []), ...(d?.hidden ?? [])]);
    for (const [k, v] of Object.entries(a)) if (!known.has(k)) out.push({ field: k, label: k, type: "unknown", value: v, text: display(undefined, v) });
    return out;
  }

  function responseSummary(r: ResponseRow, d: FormDef | undefined) {
    const meta = parse<Meta>(r.meta, {});
    return {
      id: r.id,
      form: r.form,
      status: r.status,
      language: r.language,
      startedAt: r.started_at,
      updatedAt: r.updated_at,
      submittedAt: r.submitted_at,
      page: r.page,
      pages: d?.pages.length ?? r.page + 1,
      person: { email: r.email, phone: r.phone, name: r.name, company: r.company },
      nps: r.nps,
      spamReason: r.spam_reason,
      answered: parse<string[]>(r.answered, []).length,
      preview: (answersOf(d, r) ?? []).slice(0, 4).map((x) => ({ field: x.field, label: x.label, text: x.text.slice(0, 200) })),
      hidden: meta.hidden ?? {},
      deliveries: q<{ target: Target; name: string | null; state: string }>(
        "SELECT target, name, state FROM deliveries WHERE response_id = ? ORDER BY id",
        r.id,
      ),
    };
  }

  function getResponse(id: string) {
    const r = mustResponse(id);
    const d = config?.forms.find((x) => x.id === r.form);
    const meta = parse<Meta>(r.meta, {});
    return {
      ...responseSummary(r, d),
      formName: d?.name ?? r.form,
      answers: answersOf(d, r),
      answeredFields: parse<string[]>(r.answered, []),
      shownPages: parse<number[]>(r.pages, []),
      meta: { url: meta.url ?? null, referrer: meta.referrer ?? null, utm: meta.utm ?? null, origin: meta.origin ?? null },
      deliveries: deliveriesOf(r.id),
    };
  }

  /** The filters the answers list, its CSV and the report take. */
  function filter(form: string, p: URLSearchParams) {
    const d = formDef(form);
    const c = cfg();
    const where = ["r.form = ?"];
    const args: SQLInputValue[] = [form];
    const status = p.get("status") ?? "submitted";
    if (!["submitted", "partial", "spam", "all"].includes(status)) throw bad("status is submitted, partial, spam or all.");
    if (status !== "all") (where.push("r.status = ?"), args.push(status));
    const time = "COALESCE(r.submitted_at, r.updated_at)";
    for (const [k, op, plus] of [
      ["from", ">=", 0],
      ["to", "<", DAY],
    ] as const) {
      const v = p.get(k);
      if (!v) continue;
      if (!DAY_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${k} is a day, YYYY-MM-DD.`);
      where.push(`${time} ${op} ?`);
      args.push(new Date(dayStart(v, c.timeZone) + plus).toISOString());
    }
    const text = p.get("q")?.trim();
    if (text) {
      const like = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`).toLowerCase()}%`;
      where.push(
        "(LOWER(COALESCE(r.email, '') || ' ' || COALESCE(r.name, '') || ' ' || COALESCE(r.company, '') || ' ' || COALESCE(r.answers, '')) LIKE ? ESCAPE '\\')",
      );
      args.push(like);
    }
    const consent = p.get("consent");
    if (consent) {
      if (consent !== "yes" && consent !== "no") throw bad("consent is yes (a box ticked) or no.");
      const boxes = fieldsOf(d)
        .filter((x) => x.type === "consent")
        .map((x) => x.id);
      const ticked = boxes.length ? `(${boxes.map(() => "COALESCE(json_extract(r.answers, ?), 0) = 1").join(" OR ")})` : "0";
      where.push(consent === "yes" ? ticked : `NOT ${ticked}`);
      args.push(...boxes.map((b) => `$.${b}`));
    }
    const source = p.get("source");
    if (source) {
      where.push(source === "none" ? "json_extract(r.meta, '$.utm.source') IS NULL" : "json_extract(r.meta, '$.utm.source') = ?");
      if (source !== "none") args.push(source);
    }
    const nps = p.get("nps");
    if (nps) {
      const range = { promoters: [9, 10], passives: [7, 8], detractors: [0, 6] }[nps];
      if (!range) throw bad("nps is promoters, passives or detractors.");
      where.push("r.nps BETWEEN ? AND ?");
      args.push(range[0]!, range[1]!);
    }
    for (const [k, v] of p) {
      if (!k.startsWith("answer.")) continue;
      const id = k.slice(7);
      const fd = fieldsOf(d).find((x) => x.id === id);
      const hidden = d.hidden.includes(id);
      if (!fd && !hidden) throw bad(`${k}: ${id} is not a field of the form.`);
      const value: SQLInputValue =
        fd?.type === "yes_no" || fd?.type === "consent"
          ? v === "yes" || v === "true"
            ? 1
            : 0
          : fd && ["number", "rating", "scale", "nps"].includes(fd.type)
            ? Number(v)
            : v;
      where.push("EXISTS (SELECT 1 FROM json_each(r.answers, ?) WHERE json_each.value = ?)");
      args.push(`$.${id}`, value);
    }
    return { d, where: where.join(" AND "), args, time };
  }

  function listResponses(form: string, p: URLSearchParams) {
    const { d, where, args, time } = filter(form, p);
    const limit = Math.min(Math.max(Number(p.get("limit") ?? 50) || 50, 1), 200);
    const cursor = p.get("cursor");
    const extra: SQLInputValue[] = [];
    let page = "";
    if (cursor) {
      const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
      if (!at || !id) throw bad("cursor is the nextCursor of the page before.");
      page = ` AND (${time} < ? OR (${time} = ? AND r.id < ?))`;
      extra.push(at, at, id);
    }
    const rows = q<ResponseRow>(`SELECT r.* FROM responses r WHERE ${where}${page} ORDER BY ${time} DESC, r.id DESC LIMIT ?`, ...args, ...extra, limit + 1);
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM responses r WHERE ${where}`, ...args)!.n;
    const more = rows.length > limit;
    const list = rows.slice(0, limit);
    const last = list.at(-1);
    return {
      responses: list.map((r) => responseSummary(r, d)),
      total,
      facets: facets(d, p.get("status") ?? "submitted"),
      ...(more && last && { nextCursor: Buffer.from(`${last.submitted_at ?? last.updated_at}|${last.id}`).toString("base64url") }),
    };
  }

  /** How many answers of the status have a consent box ticked, and come from each utm_source, for the filters. */
  function facets(d: FormDef, status: string) {
    const st = status === "all" ? "" : " AND status = ?";
    const a: SQLInputValue[] = status === "all" ? [d.id] : [d.id, status];
    const boxes = fieldsOf(d)
      .filter((x) => x.type === "consent")
      .map((x) => x.id);
    const ticked = boxes.length
      ? one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM responses WHERE form = ?${st} AND (${boxes.map(() => "json_extract(answers, ?) = 1").join(" OR ")})`,
          ...a,
          ...boxes.map((b) => `$.${b}`),
        )!.n
      : 0;
    const all = one<{ n: number }>(`SELECT COUNT(*) AS n FROM responses WHERE form = ?${st}`, ...a)!.n;
    const sources = q<{ value: string | null; count: number }>(
      `SELECT json_extract(meta, '$.utm.source') AS value, COUNT(*) AS count FROM responses WHERE form = ?${st} GROUP BY value ORDER BY count DESC LIMIT 20`,
      ...a,
    );
    return { consent: boxes.length ? { yes: ticked, no: all - ticked } : null, sources: sources.map((x) => ({ value: x.value ?? "none", count: x.count })) };
  }

  function exportCsv(form: string, p: URLSearchParams) {
    const { d, where, args, time } = filter(form, p);
    const rows = q<ResponseRow>(`SELECT r.* FROM responses r WHERE ${where} ORDER BY ${time} ASC, r.id ASC LIMIT 100000`, ...args);
    const lang = cfg().language;
    const fs = fieldsOf(d).filter((x) => x.type !== "statement");
    const header = [
      "Answer",
      "Status",
      "Sent",
      "Started",
      "Language",
      ...fs.map((x) => pick(x.label, lang, lang).slice(0, 120)),
      ...d.hidden,
      "Page",
      "Referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "Sent to",
    ];
    const out: unknown[][] = [header];
    for (const r of rows) {
      const a = parse<Answers>(r.answers, {});
      const meta = parse<Meta>(r.meta, {});
      const sent = q<{ target: string; name: string | null; state: string }>("SELECT target, name, state FROM deliveries WHERE response_id = ?", r.id);
      out.push([
        r.id,
        r.status,
        r.submitted_at ?? "",
        r.started_at,
        r.language,
        ...fs.map((x) => {
          const v = a[x.id];
          if (v === undefined) return "";
          if (x.type === "file") return one<{ name: string }>("SELECT name FROM files WHERE id = ?", String(v))?.name ?? "";
          return display(publicField(x, lang), v);
        }),
        ...d.hidden.map((h) => (meta.hidden?.[h] ?? a[h] ?? "") as string),
        meta.url ?? "",
        meta.referrer ?? "",
        meta.utm?.source ?? "",
        meta.utm?.medium ?? "",
        meta.utm?.campaign ?? "",
        sent.map((s) => `${s.target === "webhook" ? `webhook ${s.name}` : s.target}: ${s.state}`).join("; "),
      ]);
    }
    return { csv: toCsv(out), filename: `${d.id}-${new Date(clock()).toISOString().slice(0, 10)}.csv` };
  }

  const npsOf = (scores: number[]) => {
    if (!scores.length) return null;
    const pro = scores.filter((s) => s >= 9).length;
    const det = scores.filter((s) => s <= 6).length;
    return {
      score: Math.round(((pro - det) / scores.length) * 100),
      promoters: pro,
      passives: scores.length - pro - det,
      detractors: det,
      answers: scores.length,
    };
  };

  const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: cfg().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

  /** Monday of the week of a moment, in the file's time zone, as YYYY-MM-DD. */
  function weekOf(ms: number) {
    const dayIso = new Intl.DateTimeFormat("en-CA", { timeZone: cfg().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
    const dt = new Date(`${dayIso}T12:00:00Z`);
    const back = (dt.getUTCDay() + 6) % 7;
    return new Date(dt.getTime() - back * DAY).toISOString().slice(0, 10);
  }

  /** Each question's answers summed up, where people left the form, and NPS week by week. */
  function report(form: string, p: URLSearchParams) {
    const params = new URLSearchParams(p);
    params.set("status", "all");
    const { d, where, args } = filter(form, params);
    const rows = q<ResponseRow>(`SELECT r.* FROM responses r WHERE ${where} AND r.status != 'spam' LIMIT 200000`, ...args);
    const lang = cfg().language;
    const sent = rows.filter((r) => r.status === "submitted");
    const started = rows.length;
    const questions = fieldsOf(d)
      .filter((x) => x.type !== "statement")
      .map((fd) => {
        const pf = publicField(fd, lang);
        const values = sent.map((r) => parse<Answers>(r.answers, {})[fd.id]).filter((v): v is Value => v !== undefined);
        const shownTo = sent.filter((r) => {
          const pg = d.pages.findIndex((pp) => pp.fields.includes(fd));
          return parse<number[]>(r.pages, []).includes(pg);
        }).length;
        const base = {
          field: fd.id,
          label: fd.type === "consent" ? pick(fd.label, lang, lang) : pf.label,
          type: fd.type,
          answers: values.length,
          shown: shownTo,
        };
        if (["choice", "select", "choices", "yes_no"].includes(fd.type)) {
          const opts =
            fd.type === "yes_no"
              ? [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ]
              : pf.options;
          return {
            ...base,
            options: opts.map((o) => ({
              value: o.value,
              label: o.label,
              count: values.filter((v) =>
                Array.isArray(v) ? v.includes(o.value) : fd.type === "yes_no" ? (v ? "yes" : "no") === o.value : String(v) === o.value,
              ).length,
            })),
          };
        }
        if (["number", "rating", "scale", "nps"].includes(fd.type)) {
          const ns = values.filter((v): v is number => typeof v === "number");
          const avg = ns.length ? Math.round((ns.reduce((s, n) => s + n, 0) / ns.length) * 10) / 10 : null;
          const lo = fd.type === "nps" ? 0 : fd.type === "rating" ? 1 : fd.min;
          const hi = fd.type === "nps" ? 10 : fd.max;
          const scale =
            lo !== null && hi !== null && hi - lo <= 10
              ? Array.from({ length: hi - lo + 1 }, (_, i) => ({ value: lo + i, count: ns.filter((n) => n === lo + i).length }))
              : [];
          return {
            ...base,
            average: avg,
            min: ns.length ? Math.min(...ns) : null,
            max: ns.length ? Math.max(...ns) : null,
            scale,
            ...(fd.type === "nps" && { nps: npsOf(ns) }),
          };
        }
        if (fd.type === "consent") return { ...base, ticked: values.filter((v) => v === true).length };
        if (fd.type === "file") return base;
        const latest = sent
          .filter((r) => typeof parse<Answers>(r.answers, {})[fd.id] === "string")
          .sort((x, y) => (y.submitted_at ?? "").localeCompare(x.submitted_at ?? ""))
          .slice(0, 5)
          .map((r) => ({ response: r.id, text: String(parse<Answers>(r.answers, {})[fd.id]).slice(0, 300), at: r.submitted_at! }));
        return { ...base, latest };
      });

    // Where people left: every page reached, and the partials that stopped on it.
    const pages = d.pages.map((pg, i) => {
      const reached = rows.filter((r) => parse<number[]>(r.pages, []).includes(i) || (r.status === "partial" && i === 0)).length;
      const left = rows.filter((r) => r.status === "partial" && r.page === i).length;
      return { page: i, title: t(pg.title, lang), reached, left };
    });
    const fieldsDrop = fieldsOf(d)
      .filter((x) => x.type !== "statement")
      .map((fd) => {
        const pg = d.pages.findIndex((pp) => pp.fields.includes(fd));
        const reached = rows.filter((r) => parse<number[]>(r.pages, []).includes(pg) || (r.status === "partial" && pg === 0)).length;
        const answeredN = rows.filter((r) => parse<string[]>(r.answered, []).includes(fd.id)).length;
        return { field: fd.id, label: pick(fd.label, lang, lang).slice(0, 200), page: pg, reached, answered: answeredN };
      });

    const byDay = new Map<string, number>();
    for (const r of sent) {
      const k = new Intl.DateTimeFormat("en-CA", { timeZone: cfg().timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
        Date.parse(r.submitted_at!),
      );
      byDay.set(k, (byDay.get(k) ?? 0) + 1);
    }
    const npsField = fieldsOf(d).find((x) => x.type === "nps");
    const weeks = new Map<string, number[]>();
    const months = new Map<string, number[]>();
    if (npsField)
      for (const r of sent) {
        if (r.nps === null) continue;
        const at = Date.parse(r.submitted_at!);
        weeks.set(weekOf(at), [...(weeks.get(weekOf(at)) ?? []), r.nps]);
        const m = dayOf(at).slice(0, 7);
        months.set(m, [...(months.get(m) ?? []), r.nps]);
      }
    // The latest reasons given after an NPS score: the first text field after it, with the score and who gave it.
    const why = npsField ? fieldsOf(d).find((x, i, all) => i > all.indexOf(npsField) && (x.type === "textarea" || x.type === "text")) : undefined;
    const reasons = why
      ? sent
          .filter((r) => typeof parse<Answers>(r.answers, {})[why.id] === "string")
          .sort((x, y) => (y.submitted_at ?? "").localeCompare(x.submitted_at ?? ""))
          .slice(0, 10)
          .map((r) => ({
            response: r.id,
            score: r.nps,
            text: String(parse<Answers>(r.answers, {})[why.id]).slice(0, 500),
            name: r.name ?? r.email,
            at: r.submitted_at!,
          }))
      : [];
    const sources = new Map<string, number>();
    for (const r of sent) {
      const src = parse<Meta>(r.meta, {}).utm?.source ?? "none";
      sources.set(src, (sources.get(src) ?? 0) + 1);
    }
    const from = p.get("from");
    const to = p.get("to");
    const views =
      one<{ n: number | null }>(
        `SELECT SUM(n) AS n FROM views WHERE form = ?${from ? " AND day >= ?" : ""}${to ? " AND day <= ?" : ""}`,
        d.id,
        ...[from, to].filter((x): x is string => !!x),
      )!.n ?? 0;
    return {
      form: d.id,
      views,
      started,
      submitted: sent.length,
      partial: rows.filter((r) => r.status === "partial").length,
      completion: started ? Math.round((sent.length / started) * 1000) / 10 : null,
      medianSeconds: median(sent.map((r) => (Date.parse(r.submitted_at!) - Date.parse(r.started_at)) / 1000)),
      nps: npsField ? npsOf(sent.map((r) => r.nps).filter((n): n is number => n !== null)) : null,
      npsWeeks: [...weeks].sort((x, y) => x[0].localeCompare(y[0])).map(([week, s]) => ({ week, ...npsOf(s)! })),
      npsMonths: [...months].sort((x, y) => x[0].localeCompare(y[0])).map(([month, s]) => ({ month, ...npsOf(s)! })),
      reasons,
      sources: [...sources].sort((x, y) => y[1] - x[1]).map(([value, count]) => ({ value, count })),
      days: [...byDay].sort((x, y) => x[0].localeCompare(y[0])).map(([day, n]) => ({ day, answers: n })),
      questions,
      pages,
      fields: fieldsDrop,
    };
  }

  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
  };

  /** Every form with its answers this week and where they went. */
  function listForms() {
    const c = cfg();
    const week = iso(clock() - 7 * DAY);
    const month = iso(clock() - 30 * DAY);
    return c.forms.map((d) => {
      const n = (sql: string, ...a: SQLInputValue[]) => one<{ n: number }>(sql, ...a)!.n;
      const submittedWeek = n("SELECT COUNT(*) AS n FROM responses WHERE form = ? AND status = 'submitted' AND submitted_at >= ?", d.id, week);
      const partialWeek = n("SELECT COUNT(*) AS n FROM responses WHERE form = ? AND status = 'partial' AND started_at >= ?", d.id, week);
      const routes = q<{ target: Target; name: string | null; state: string; n: number }>(
        `SELECT d.target, d.name, d.state, COUNT(*) AS n FROM deliveries d JOIN responses r ON r.id = d.response_id
         WHERE r.form = ? AND d.created_at >= ? GROUP BY d.target, d.name, d.state`,
        d.id,
        week,
      );
      const routeOf = (target: Target, name: string | null = null) => {
        const of = routes.filter((x) => x.target === target && (name === null || x.name === name));
        return {
          sent: of.filter((x) => x.state === "sent").reduce((s, x) => s + x.n, 0),
          waiting: of.filter((x) => x.state === "waiting").reduce((s, x) => s + x.n, 0),
          failed: of.filter((x) => x.state === "failed").reduce((s, x) => s + x.n, 0),
        };
      };
      const fs = fieldsOf(d);
      const destinations = [
        ...(fs.some((x) => x.type === "consent") && c.consent ? [{ target: "consent" as const, name: null, ...routeOf("consent") }] : []),
        ...(d.send.audience && c.audience ? [{ target: "audience" as const, name: null, ...routeOf("audience") }] : []),
        ...(d.send.crm && c.crm ? [{ target: "crm" as const, name: null, ...routeOf("crm") }] : []),
        ...(d.send.helpdesk && c.helpdesk ? [{ target: "helpdesk" as const, name: null, ...routeOf("helpdesk") }] : []),
        ...(d.send.notify.length && c.mail ? [{ target: "mail" as const, name: null, ...routeOf("mail") }] : []),
        ...d.send.webhooks.map((w) => ({ target: "webhook" as const, name: w, ...routeOf("webhook", w) })),
      ];
      const last = one<{ at: string | null }>("SELECT MAX(submitted_at) AS at FROM responses WHERE form = ? AND status = 'submitted'", d.id)!.at;
      const views = one<{ n: number | null }>("SELECT SUM(n) AS n FROM views WHERE form = ? AND day > ?", d.id, dayOf(clock() - 7 * DAY))!.n ?? 0;
      const boxes = fs.filter((x) => x.type === "consent").map((x) => x.id);
      const ticked = boxes.length
        ? n(
            `SELECT COUNT(*) AS n FROM responses WHERE form = ? AND status = 'submitted' AND submitted_at >= ? AND (${boxes.map(() => "json_extract(answers, ?) = 1").join(" OR ")})`,
            d.id,
            week,
            ...boxes.map((b) => `$.${b}`),
          )
        : null;
      const npsScores =
        d.kind === "nps"
          ? q<{ nps: number }>("SELECT nps FROM responses WHERE form = ? AND status = 'submitted' AND nps IS NOT NULL AND submitted_at >= ?", d.id, month).map(
              (x) => x.nps,
            )
          : [];
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        title: t(d.title, c.language)!,
        state: closedState(d) ?? "open",
        closes: d.closes,
        limit: d.limit,
        pages: d.pages.length,
        fields: fs.filter((x) => x.type !== "statement").length,
        languages: formLanguages(d, c.language),
        week: {
          views,
          submitted: submittedWeek,
          partial: partialWeek,
          leads: routeOf("crm").sent,
          consent: ticked,
          spam: n("SELECT COUNT(*) AS n FROM responses WHERE form = ? AND status = 'spam' AND updated_at >= ?", d.id, week),
          completion: submittedWeek + partialWeek ? Math.round((submittedWeek / (submittedWeek + partialWeek)) * 1000) / 10 : null,
        },
        total: n("SELECT COUNT(*) AS n FROM responses WHERE form = ? AND status = 'submitted'", d.id),
        lastAt: last,
        nps: d.kind === "nps" ? npsOf(npsScores) : null,
        destinations,
        file: d.file,
        embedOn: d.embed.map((o) => new URL(o).host),
        url: `${opts.publicUrl}/f/${d.id}`,
      };
    });
  }

  /** The form as it is written: its own file, or its part of forms.yaml. */
  function formYaml(d: FormDef): string {
    const own = formFiles.get(d.file);
    if (own !== undefined) return own;
    try {
      const doc = parseYaml(yaml) as { forms?: Record<string, unknown> } | null;
      return stringifyYaml({ forms: { [d.id]: doc?.forms?.[d.id] ?? {} } }, { lineWidth: 0 });
    } catch {
      return "";
    }
  }

  /** One form as the file sets it, for its page in the UI: the questions, where answers go, and how to embed it. */
  function getForm(id: string, lang?: string | null) {
    const d = formDef(id);
    const c = cfg();
    const offered = formLanguages(d, c.language);
    const l = lang && (offered as string[]).includes(lang) ? (lang as Lang) : offered.includes(c.language) ? c.language : offered[0]!;
    const summary = listForms().find((x) => x.id === id)!;
    return {
      ...summary,
      language: l,
      description: t(d.description, l),
      definition: { title: t(d.title, l)!, pages: pagesOf(d, l), hidden: d.hidden },
      yaml: formYaml(d),
      person: d.person,
      embed: {
        url: `${opts.publicUrl}/f/${d.id}`,
        script: `<script src="${opts.publicUrl}/embed.js" data-form="${d.id}" async></script>`,
        frame: `<iframe src="${opts.publicUrl}/f/${d.id}?frame=1" title="${d.name.replace(/"/g, "&quot;")}" style="width:100%;min-height:640px;border:0"></iframe>`,
        origins: d.embed,
      },
      spam: {
        minSeconds: d.spam.minSeconds,
        rate: d.spam.rate.text,
        proofOfWork: d.spam.proofOfWork,
        captcha: d.spam.captcha && c.captcha ? c.captcha.provider : null,
      },
      partials: d.partials,
      sendTo: {
        audience: d.send.audience && !!c.audience,
        consent: fieldsOf(d)
          .filter((x) => x.type === "consent")
          .map((x) => ({
            field: x.id,
            purpose: x.consent!.purpose,
            channels: x.consent!.channels,
            linked: !!c.consent,
            version: purposes.get(x.consent!.purpose)?.current ?? null,
          })),
        crm: d.send.crm && c.crm ? { title: d.send.crm.title, owner: d.send.crm.owner, ownerBy: d.send.crm.ownerBy, value: d.send.crm.value } : null,
        helpdesk: d.send.helpdesk && c.helpdesk ? d.send.helpdesk : null,
        notify: c.mail ? d.send.notify : [],
        webhooks: d.send.webhooks,
        traits: fieldsOf(d)
          .filter((x) => x.trait)
          .map((x) => ({ field: x.id, trait: x.trait! })),
      },
    };
  }

  function setSpam(who: Actor, id: string, spam: boolean) {
    const r = mustResponse(id);
    if (r.status === "partial") throw new FormsError(409, "conflict", "A partial answer was never sent.");
    const d = config?.forms.find((x) => x.id === r.form);
    tx(() => {
      if (spam) {
        run("UPDATE responses SET status = 'spam', spam_reason = ?, updated_at = ? WHERE id = ?", `marked by ${who.name}`.slice(0, 200), iso(), id);
        run("DELETE FROM deliveries WHERE response_id = ? AND state = 'waiting'", id);
      } else if (r.status === "spam") {
        if (!d) throw new FormsError(409, "conflict", "Its form is no longer in the file, so it cannot be sent anywhere.");
        run("UPDATE responses SET status = 'submitted', spam_reason = NULL, updated_at = ? WHERE id = ?", iso(), id);
        enqueue(d, mustResponse(id), {});
      }
    });
    queueMicrotask(() => void flush());
    return getResponse(id);
  }

  function retry(id: string) {
    mustResponse(id);
    run("UPDATE deliveries SET state = 'waiting', next_at = ?, done_at = NULL WHERE response_id = ? AND state = 'failed'", iso(), id);
    queueMicrotask(() => void flush());
    return getResponse(id);
  }

  function removeResponse(id: string) {
    mustResponse(id);
    run("DELETE FROM responses WHERE id = ?", id);
  }

  function file(id: string) {
    const r = one<FileRow>("SELECT * FROM files WHERE id = ? AND response_id IS NOT NULL", id);
    if (!r) throw notFound("The file");
    return r;
  }

  /** Audience's erasure contract: every answer with one of the person's emails, phone numbers or user id goes. */
  function erase(raw: unknown) {
    const b = body(raw, ["reference", "product", "people"]);
    const reference = typeof b.reference === "string" && b.reference.trim() ? b.reference.trim().slice(0, 200) : null;
    if (!reference) throw bad("reference is the deletion's reference, such as KVKK-2026-031.");
    if (!isObj(b.people)) throw bad("people is { emails, phones, userIds }.");
    const list = (k: string) =>
      Array.isArray((b.people as Record<string, unknown>)[k])
        ? ((b.people as Record<string, unknown>)[k] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
    const done = one<{ deleted: number }>("SELECT deleted FROM erasures WHERE reference = ?", reference);
    if (done) return { status: "done", deleted: done.deleted };
    const emails = list("emails").map((e) => e.trim().toLowerCase());
    const phones = list("phones")
      .map(phoneKey)
      .filter((x): x is string => !!x);
    const users = list("userIds");
    const deleted = tx(() => {
      let n = 0;
      const inList = (col: string, xs: string[]) => {
        if (!xs.length) return;
        n += Number(run(`DELETE FROM responses WHERE ${col} IN (${xs.map(() => "?").join(", ")})`, ...xs).changes);
      };
      inList("email", emails);
      inList("phone_key", phones);
      inList("user_id", users);
      run("INSERT INTO erasures (reference, at, deleted) VALUES (?, ?, ?)", reference, iso(), n);
      return n;
    });
    return { status: "done", deleted };
  }

  function summary() {
    const week = iso(clock() - 7 * DAY);
    const n = (sql: string, ...a: SQLInputValue[]) => one<{ n: number }>(sql, ...a)!.n;
    return {
      forms: config?.forms.length ?? 0,
      week: n("SELECT COUNT(*) AS n FROM responses WHERE status = 'submitted' AND submitted_at >= ?", week),
      failed: n("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'failed'"),
      waiting: n("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'waiting'"),
      file: opts.fileState?.() ?? null,
    };
  }

  function settings() {
    const c = config;
    return {
      file: opts.fileState?.() ?? null,
      yaml,
      config: c && {
        language: c.language,
        timeZone: c.timeZone,
        keep: c.keep,
        forms: c.forms.map((x) => ({
          id: x.id,
          name: x.name,
          kind: x.kind,
          spam: { ...x.spam, rate: x.spam.rate.text },
          partials: x.partials,
          embed: x.embed,
        })),
        mail: c.mail && { host: c.mail.host, port: c.mail.port, security: c.mail.security, from: c.mail.from, password: c.mail.password },
        analytics: c.analytics,
        captcha: c.captcha,
        consent: c.consent,
        audience: c.audience,
        crm: c.crm,
        helpdesk: c.helpdesk,
        webhooks: c.webhooks,
      },
    };
  }

  /** The links in the file, whether their secrets are set, and how sending to them goes. */
  function integrations() {
    const c = cfg();
    const stats = (target: Target, name?: string) => {
      const where = name ? "target = ? AND name = ?" : "target = ?";
      const a: SQLInputValue[] = name ? [target, name] : [target];
      const g = (state: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries WHERE ${where} AND state = ?`, ...a, state)!.n;
      const last = one<{ at: string | null }>(`SELECT MAX(done_at) AS at FROM deliveries WHERE ${where} AND state = 'sent'`, ...a)!.at;
      const err = one<{ error: string | null }>(`SELECT error FROM deliveries WHERE ${where} AND error IS NOT NULL ORDER BY id DESC LIMIT 1`, ...a);
      return { waiting: g("waiting"), failed: g("failed"), lastSentAt: last, lastError: err?.error ?? null };
    };
    const link = (id: Target, l: { url: string; token: string } | null) => ({
      id,
      linked: !!l,
      url: l?.url ?? null,
      secret: l?.token ?? null,
      secretSet: !!l && !!env[l.token],
      ...stats(id),
    });
    return {
      links: [
        { ...link("consent", c.consent), purposes: [...purposes.values()].map((p) => ({ id: p.id, version: p.current })), error: purposesError },
        link("audience", c.audience),
        link("crm", c.crm),
        link("helpdesk", c.helpdesk && { url: c.helpdesk.url, token: c.helpdesk.key }),
        {
          id: "mail" as const,
          linked: !!c.mail,
          url: c.mail ? `${c.mail.host}:${c.mail.port}` : null,
          secret: c.mail?.password ?? null,
          secretSet: !!c.mail && (!c.mail.user || !!env[c.mail.password]),
          ...stats("mail"),
        },
      ],
      webhooks: c.webhooks.map((w) => ({ id: w.id, url: w.url, secret: w.secret, secretSet: !!env[w.secret], ...stats("webhook", w.id) })),
      analytics: c.analytics,
      captcha: c.captcha && { provider: c.captcha.provider, siteKey: c.captcha.siteKey, secret: c.captcha.secret, secretSet: !!env[c.captcha.secret] },
    };
  }

  function gauges() {
    const byState = q<{ target: string; state: string; n: number }>(
      "SELECT target, state, COUNT(*) AS n FROM deliveries WHERE state != 'sent' GROUP BY target, state",
    );
    const responses = q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM responses GROUP BY status");
    return {
      responses: Object.fromEntries(responses.map((r) => [r.status, r.n])) as Record<string, number>,
      deliveries: byState,
      counters,
      forms: config?.forms.length ?? 0,
    };
  }

  return {
    config: () => config,
    setConfig,
    languages,
    publicForm,
    formDef,
    submit,
    progress,
    upload,
    listForms,
    getForm,
    listResponses,
    exportCsv,
    report,
    getResponse,
    setSpam,
    retry,
    removeResponse,
    file,
    erase,
    summary,
    settings,
    integrations,
    gauges,
    flush,
    tick,
    sweep,
    refreshPurposes,
    langs: LANGS,
  };
}

export type Forms = ReturnType<typeof createForms>;
