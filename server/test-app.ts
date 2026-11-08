// Starts the app on a random port for tests, with the fakes of Consent, Audience, CRM, Helpdesk, a webhook receiver
// and a captcha, and a mailer that keeps what it is given.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { CAPTCHA_SECRET, HOOK_SECRET, startFakes, TOKENS } from "./fakes.ts";
import { createForms } from "./forms.ts";
import type { Mail, Mailer } from "./links.ts";
import { doWork } from "./spam.ts";

export const ADMIN_TOKEN = "test-admin-token";

/** The settings file the tests start with; FAKES is replaced with the fakes' address. */
export const SETTINGS = `
language: en
time_zone: Europe/Istanbul
spam: { min_time: 3s, rate: 5/m }
mail: { host: localhost, port: 2525, security: none, from: Forms <forms@example.com> }
consent: { url: FAKES/consent, token: T_CONSENT }
audience: { url: FAKES/audience, token: T_AUDIENCE }
crm: { url: FAKES/crm, token: T_CRM }
helpdesk: { url: FAKES/helpdesk, key: T_HELPDESK }
webhooks:
  zapier: { url: FAKES/hook/in, secret: T_HOOK }
forms:
  demo:
    name: Demo request
    kind: lead
    title: { en: Book a demo, tr: Demo isteyin }
    embed: [https://www.example.com]
    hidden: [plan]
    pages:
      - title: { en: About you, tr: Sizi tanıyalım }
        fields:
          - { id: name, type: text, label: { en: Name, tr: Ad }, required: true }
          - { id: email, type: email, label: { en: Work email, tr: İş e-postası }, required: true }
          - { id: company, type: text, label: { en: Company, tr: Şirket } }
          - { id: size, type: choice, label: { en: Team size, tr: Ekip }, options: [1-10, 11-50, 51-200, 200+], required: true }
      - title: { en: Your needs, tr: İhtiyaçlar }
        show_if: { field: size, in: [51-200, 200+] }
        fields:
          - { id: region, type: select, label: Region, options: [{ value: emea, label: EMEA }, { value: apac, label: APAC }], required: true, trait: region }
          - { id: cv, type: file, label: Brief, types: [pdf, png], max_size: 100KB }
      - fields:
          - { id: message, type: textarea, label: { en: Anything else?, tr: Başka? } }
          - { id: marketing, type: consent, purpose: marketing, channels: [email], label: { en: Send me offers by email, tr: Bana teklif gönderin } }
    send_to:
      crm: { title: "Demo: {company}", owner: sales@example.com, owner_by: { field: region, owners: { apac: apac@example.com } } }
      notify: [sales@example.com]
      webhooks: [zapier]
  support:
    name: Contact us
    kind: contact
    fields:
      - { id: email, type: email, label: Email, required: true }
      - { id: topic, type: select, label: Topic, options: [billing, bug] }
      - { id: message, type: textarea, label: Message, required: true, min: 10 }
    send_to: { audience: false, helpdesk: { form: billing, subject: "Contact: {topic}" } }
    partials: answers
  nps:
    name: NPS
    kind: nps
    fields:
      - { id: score, type: nps, label: How likely are you to recommend us?, required: true }
      - { id: why, type: textarea, label: Why?, show_if: { field: score, below: 7 } }
    hidden: [user_id]
    partials: off
    spam: { min_time: 0s, proof_of_work: 10 }
`;

/** A clock the test moves by hand: Monday 2 November 2026, 09:00 in Istanbul. */
export function fakeClock(start = Date.parse("2026-11-02T06:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; settings?: string; env?: Record<string, string> } = {}) {
  const fakes = await startFakes();
  const db = openDb(":memory:");
  const { settings = SETTINGS, version = "0.1.0", env: extraEnv = {}, ...rest } = opts;
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "forms", productName: "OpenAsy Forms", origin: base });
  const mails: Mail[] = [];
  const mailer: Mailer & { fail: boolean } = {
    fail: false,
    async send(m) {
      if (this.fail) throw new Error("connect ECONNREFUSED");
      mails.push(m);
    },
    close() {},
  };
  const env = {
    T_CONSENT: TOKENS.consent,
    T_AUDIENCE: TOKENS.audience,
    T_CRM: TOKENS.crm,
    T_HELPDESK: TOKENS.helpdesk,
    T_HOOK: HOOK_SECRET,
    FORMS_CAPTCHA_SECRET: CAPTCHA_SECRET,
    ...extraEnv,
  };
  const forms = createForms(db, {
    publicUrl: base,
    tokenKey: Buffer.alloc(32, 9),
    env,
    clock,
    mailer: (c) => (c.mail ? mailer : null),
    captchaEndpoints: { turnstile: `${fakes.base}/captcha/siteverify`, hcaptcha: `${fakes.base}/captcha/siteverify` },
  });
  const text = settings.replaceAll("FAKES", fakes.base);
  forms.setConfig(parseConfig(text), text);
  await forms.refreshPurposes(true);
  handler = createApp({ db, forms, auth, publicUrl: base, adminToken: ADMIN_TOKEN, version, trustProxy: true, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  let ip = 1;
  /** A page's request, from its own address so rate limits do not mix tests. */
  const visitor = (path: string, init: RequestInit = {}, address = `10.0.0.${ip++ % 250}`) =>
    fetch(base + path, { ...init, headers: { "content-type": "application/json", "x-forwarded-for": address, ...init.headers } });
  /** Loads a form as a page does, then lets the time a person needs pass. */
  const load = async (id: string, lang = "en") => {
    const r = await visitor(`/api/v1/public/forms/${id}?lang=${lang}`);
    const form = (await r.json()) as { token: string; spam: { proofOfWork: number | null } & Record<string, any> } & Record<string, any>;
    clock.advance(5000);
    return form;
  };
  /** Sends an answer as a page does. */
  const answer = async (id: string, answers: Record<string, unknown>, extra: Record<string, unknown> = {}, address?: string) => {
    const form = await load(id);
    const proof = form.spam.proofOfWork ? doWork(form.token, form.spam.proofOfWork) : undefined;
    const res = await visitor(
      `/api/v1/public/forms/${id}/responses`,
      {
        method: "POST",
        body: JSON.stringify({
          token: form.token,
          answers,
          language: "en",
          page: { url: "https://www.example.com/pricing?utm_source=google&utm_campaign=winter&email=x", referrer: "https://www.google.com/search?q=x" },
          ...(proof && { proof }),
          ...extra,
        }),
      },
      address,
    );
    return { res, body: (await res.json()) as any, form };
  };
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakes.close();
  };
  return { db, forms, auth, base, admin, visitor, load, answer, clock, fakes, mails, mailer, env, close };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;
