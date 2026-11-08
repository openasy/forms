// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.
import type { PublicField, PublicPage, Value } from "../../server/logic.ts";

export type { PublicField, PublicPage, Value };

export interface ProductLink {
  id: string;
  url: string;
}

export type ConfigFile = { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;
export type Kind = "lead" | "contact" | "nps" | "survey";
export type Target = "consent" | "audience" | "crm" | "helpdesk" | "mail" | "webhook";

export interface Summary {
  forms: number;
  week: number;
  failed: number;
  waiting: number;
  file: ConfigFile;
}

type Link = { url: string; token: string } | null;
export interface Settings {
  file: ConfigFile;
  yaml: string;
  config: {
    language: string;
    timeZone: string;
    keep: { partialDays: number; spamDays: number; responseDays: number | null };
    forms: Array<{
      id: string;
      name: string;
      kind: Kind;
      spam: { minSeconds: number; rate: string; proofOfWork: number | null; captcha: boolean };
      partials: "off" | "progress" | "answers";
      embed: string[];
    }>;
    mail: { host: string; port: number; security: string; from: string; password: string } | null;
    analytics: string | null;
    captcha: { provider: string; siteKey: string; secret: string } | null;
    consent: Link;
    audience: Link;
    crm: Link;
    helpdesk: { url: string; key: string } | null;
    webhooks: Array<{ id: string; url: string; secret: string }>;
  } | null;
}

export interface Nps {
  score: number;
  promoters: number;
  passives: number;
  detractors: number;
  answers: number;
}

export interface Route {
  target: Target;
  name: string | null;
  sent: number;
  waiting: number;
  failed: number;
}

export interface FormSummary {
  id: string;
  name: string;
  kind: Kind;
  title: string;
  state: "open" | "closed" | "full";
  closes: string | null;
  limit: number | null;
  pages: number;
  fields: number;
  languages: string[];
  week: { views: number; submitted: number; partial: number; leads: number; consent: number | null; spam: number; completion: number | null };
  total: number;
  lastAt: string | null;
  nps: Nps | null;
  destinations: Route[];
  file: string;
  embedOn: string[];
  url: string;
}

export interface FormDetail extends FormSummary {
  language: string;
  description: string | null;
  definition: { title: string; pages: PublicPage[]; hidden: string[] };
  yaml: string;
  person: { email: string | null; phone: string | null; name: string | null; company: string | null; userId: string | null };
  embed: { url: string; script: string; frame: string; origins: string[] };
  spam: { minSeconds: number; rate: string; proofOfWork: number | null; captcha: string | null };
  partials: "off" | "progress" | "answers";
  sendTo: {
    audience: boolean;
    consent: Array<{ field: string; purpose: string; channels: string[]; linked: boolean; version: number | null }>;
    crm: { title: string | null; owner: string | null; ownerBy: { field: string; owners: Record<string, string> } | null; value: number | null } | null;
    helpdesk: { form: string; subject: string | null; message: string | null } | null;
    notify: string[];
    webhooks: string[];
    traits: Array<{ field: string; trait: string }>;
  };
}

export interface ResponseSummary {
  id: string;
  form: string;
  status: "partial" | "submitted" | "spam";
  language: string;
  startedAt: string;
  updatedAt: string;
  submittedAt: string | null;
  page: number;
  pages: number;
  person: { email: string | null; phone: string | null; name: string | null; company: string | null };
  nps: number | null;
  spamReason: string | null;
  answered: number;
  preview: Array<{ field: string; label: string; text: string }>;
  hidden: Record<string, string>;
  deliveries: Array<{ target: Target; name: string | null; state: string }>;
}

export interface ResponseList {
  responses: ResponseSummary[];
  total: number;
  nextCursor?: string;
  facets: { consent: { yes: number; no: number } | null; sources: Array<{ value: string; count: number }> };
}

export interface Delivery {
  id: number;
  target: Target;
  name: string | null;
  state: "waiting" | "sent" | "failed";
  attempts: number;
  error: string | null;
  result: Record<string, unknown> | null;
  nextAt: string | null;
  createdAt: string;
  doneAt: string | null;
}

export interface ResponseDetail extends Omit<ResponseSummary, "deliveries"> {
  formName: string;
  answers: Array<{
    field: string;
    label: string;
    type: string;
    value: Value;
    text: string;
    file?: { id: string; name: string; size: number; type: string };
  }> | null;
  answeredFields: string[];
  shownPages: number[];
  meta: {
    url: string | null;
    referrer: string | null;
    utm: { source: string | null; medium: string | null; campaign: string | null } | null;
    origin: string | null;
  };
  deliveries: Delivery[];
}

export interface Question {
  field: string;
  label: string;
  type: string;
  answers: number;
  shown: number;
  options?: Array<{ value: string; label: string; count: number }>;
  average?: number | null;
  scale?: Array<{ value: number; count: number }>;
  nps?: Nps | null;
  ticked?: number;
  latest?: Array<{ response: string; text: string; at: string }>;
}

export interface Report {
  form: string;
  views: number;
  started: number;
  submitted: number;
  partial: number;
  completion: number | null;
  medianSeconds: number | null;
  nps: Nps | null;
  npsWeeks: Array<Nps & { week: string }>;
  npsMonths: Array<Nps & { month: string }>;
  reasons: Array<{ response: string; score: number | null; text: string; name: string | null; at: string }>;
  sources: Array<{ value: string; count: number }>;
  days: Array<{ day: string; answers: number }>;
  questions: Question[];
  pages: Array<{ page: number; title: string | null; reached: number; left: number }>;
  fields: Array<{ field: string; label: string; page: number; reached: number; answered: number }>;
}

type LinkState = { waiting: number; failed: number; lastSentAt: string | null; lastError: string | null };
export interface Integrations {
  links: Array<
    LinkState & {
      id: Target;
      linked: boolean;
      url: string | null;
      secret: string | null;
      secretSet: boolean;
      purposes?: Array<{ id: string; version: number }>;
      error?: string | null;
    }
  >;
  webhooks: Array<LinkState & { id: string; url: string; secret: string; secretSet: boolean }>;
  analytics: string | null;
  captcha: { provider: string; siteKey: string; secret: string; secretSet: boolean } | null;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
