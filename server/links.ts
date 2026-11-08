// The other products and services Forms talks to, each behind a small function so the tests can point it at a fake.
// Requests are written to the other products' openapi.json (copied in siblings.json, which the fakes check them with):
//
// - Consent: a ticked box is POST /api/v1/consents (RecordRequest) with source form; the boxes' texts come from
//   GET /api/v1/purposes.
// - Audience: each answer is a form_submitted event, POST /api/v1/events (EventBatch) with source forms.
// - CRM: a lead form's answer is POST /api/v1/leads (LeadRequest) with source forms.
// - Helpdesk: a contact form's answer is a ticket, POST /api/v1/public/tickets (PublicTicket) with the forms key.
// - Webhooks: the answer as JSON, signed as Standard Webhooks signs (webhook-id, webhook-timestamp, webhook-signature).
// - Turnstile or hCaptcha: the captcha's answer is checked at the provider's siteverify.
// - Mail: notifications go out through the SMTP server in the file.
import { createHmac } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.ts";

export class LinkError extends Error {
  /** true when sending the same again gives the same answer: a refused body or token. */
  readonly permanent: boolean;
  readonly status: number | null;
  constructor(message: string, status: number | null = null, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export interface Call {
  method?: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  product: string;
  timeoutMs?: number;
}

/** One request; the answer's JSON, or a LinkError that says whether trying again could help. */
export async function request(f: typeof fetch, c: Call): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await f(c.url, {
      method: c.method ?? "POST",
      headers: { accept: "application/json", ...(c.body !== undefined && { "content-type": "application/json" }), ...c.headers },
      body: c.body,
      signal: AbortSignal.timeout(c.timeoutMs ?? 10_000),
      redirect: "error",
    });
  } catch (err) {
    throw new LinkError(`${c.product} could not be reached: ${(err as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  let answer: unknown = null;
  try {
    answer = text ? JSON.parse(text) : null;
  } catch {
    answer = null;
  }
  if (!res.ok) {
    const detail = str(obj(answer)?.detail);
    // 4xx but 408 and 429 are the request's fault: sending it again gives the same answer.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new LinkError(`${c.product} answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, permanent);
  }
  return { status: res.status, body: answer };
}

const bearer = (token: string | undefined, product: string) => {
  if (!token) throw new LinkError(`The ${product} token is not set.`, null, true);
  return { authorization: `Bearer ${token}` };
};

// ---------------------------------------------------------------- Consent

/** A purpose as Consent's GET /api/v1/purposes gives it, with only what a box needs. */
export interface ConsentPurpose {
  id: string;
  current: number;
  /** The current version's text: one text, or one per language. */
  text: string | Record<string, string>;
  channels: string[];
}

export async function consentPurposes(f: typeof fetch, url: string, token: string | undefined): Promise<ConsentPurpose[]> {
  const r = await request(f, { method: "GET", url: `${url}/api/v1/purposes`, headers: bearer(token, "Consent"), product: "Consent" });
  const list = Array.isArray(obj(r.body)?.purposes) ? (obj(r.body)!.purposes as unknown[]) : [];
  return list.flatMap((p) => {
    const o = obj(p);
    if (!o || typeof o.id !== "string" || typeof o.current !== "number") return [];
    const v = (Array.isArray(o.versions) ? o.versions : []).map(obj).find((x) => x?.version === o.current);
    const text = v?.text;
    if (typeof text !== "string" && !obj(text)) return [];
    return [{ id: o.id, current: o.current, text: text as ConsentPurpose["text"], channels: Array.isArray(o.channels) ? o.channels.map(String) : [] }];
  });
}

/** RecordRequest, as Consent takes it. */
export interface ConsentRecord {
  person: { email?: string; phone?: string; id?: string };
  answers: Array<{ purpose: string; channel: string; granted: true; version?: number; at: string; proof: string }>;
  source: "form";
  via: string;
}

export async function recordConsent(f: typeof fetch, url: string, token: string | undefined, rec: ConsentRecord) {
  const r = await request(f, { url: `${url}/api/v1/consents`, headers: bearer(token, "Consent"), body: JSON.stringify(rec), product: "Consent" });
  return { person: str(obj(r.body)?.person, 200) };
}

// ---------------------------------------------------------------- Audience

/** EventInput, as Audience takes it. */
export interface AudienceEvent {
  source: "forms";
  type: "form_submitted";
  id: string;
  at: string;
  person: { email?: string | null; phone?: string | null; userId?: string | null; name?: string | null };
  traits?: Record<string, string | number | boolean>;
  properties: Record<string, string | number | boolean>;
  text: string;
}

export async function sendToAudience(f: typeof fetch, url: string, token: string | undefined, event: AudienceEvent) {
  const r = await request(f, {
    url: `${url}/api/v1/events`,
    headers: bearer(token, "Audience"),
    body: JSON.stringify({ events: [event] }),
    product: "Audience",
  });
  const first = obj((obj(r.body)?.results as unknown[] | undefined)?.[0]);
  return { profile: str(first?.profile, 200) };
}

// ---------------------------------------------------------------- CRM

/** LeadRequest, as CRM takes it from forms. */
export interface CrmLead {
  external_id: string;
  source: "forms";
  title: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  page?: string | null;
  referrer?: string | null;
  utm?: { source: string | null; medium: string | null; campaign: string | null } | null;
  owner?: { email: string } | null;
  value?: number | null;
  message?: string | null;
}

export async function openLead(f: typeof fetch, url: string, token: string | undefined, lead: CrmLead) {
  const r = await request(f, { url: `${url}/api/v1/leads`, headers: bearer(token, "CRM"), body: JSON.stringify(lead), product: "CRM" });
  const l = obj(obj(r.body)?.lead);
  return { id: str(l?.id, 200), url: str(l?.url, 2000) };
}

// ---------------------------------------------------------------- Helpdesk

/** PublicTicket, as Helpdesk takes it from a server with the source's key. */
export interface HelpdeskTicket {
  email: string;
  name?: string;
  subject?: string;
  message: string;
  form: string;
  fields?: Record<string, string | number | boolean>;
  language?: string;
  external_id: string;
}

export async function openTicket(f: typeof fetch, url: string, key: string | undefined, ticket: HelpdeskTicket) {
  if (!key) throw new LinkError("The Helpdesk key is not set.", null, true);
  const r = await request(f, {
    url: `${url}/api/v1/public/tickets`,
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify(ticket),
    product: "Helpdesk",
  });
  const t = obj(obj(r.body)?.ticket);
  return { number: typeof t?.number === "number" ? t.number : null, reference: str(t?.reference, 100) };
}

// ---------------------------------------------------------------- Webhooks

/**
 * The signature Standard Webhooks (standardwebhooks.com) defines: HMAC-SHA256 of "<id>.<timestamp>.<body>", base64,
 * as "v1,<signature>". A secret written whsec_<base64> is used as those bytes, any other as its UTF-8 bytes.
 */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export async function sendWebhook(f: typeof fetch, url: string, secret: string | undefined, id: string, timestamp: number, body: string) {
  if (!secret) throw new LinkError("The webhook's secret is not set.", null, true);
  const r = await request(f, {
    url,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook(secret, id, timestamp, body),
      "user-agent": "OpenAsy-Forms",
    },
    body,
    product: "The webhook",
  });
  return { status: r.status };
}

// ---------------------------------------------------------------- Captcha

export const CAPTCHA_VERIFY = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  hcaptcha: "https://api.hcaptcha.com/siteverify",
};

/** Whether the provider says the page's captcha answer is good. The person's address is not sent. */
export async function verifyCaptcha(f: typeof fetch, endpoint: string, secret: string | undefined, response: unknown, siteKey: string): Promise<boolean> {
  if (!secret || typeof response !== "string" || !response || response.length > 4096) return false;
  let res: Response;
  try {
    res = await f(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response, sitekey: siteKey }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (err) {
    throw new LinkError(`The captcha could not be checked: ${(err as Error).message}`);
  }
  const answer = obj(await res.json().catch(() => null));
  return res.ok && answer?.success === true;
}

// ---------------------------------------------------------------- Mail

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  close(): void;
}

export function smtpMailer(m: NonNullable<Config["mail"]>, password: string | undefined, o: { allowPlain?: boolean } = {}): Mailer {
  const t: Transporter = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.security === "tls",
    requireTLS: m.security === "starttls" && !o.allowPlain,
    ignoreTLS: m.security === "none",
    auth: m.user && password ? { user: m.user, pass: password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      await t.sendMail({ from: m.from, to: mail.to, subject: mail.subject, text: mail.text, replyTo: mail.replyTo });
    },
    close: () => t.close(),
  };
}
