// Fakes of what Forms talks to, on one local HTTP server, for the tests: Consent, Audience, CRM and Helpdesk, a
// webhook receiver and a captcha's siteverify. Each checks the request against the product's own openapi.json (the
// copy in siblings.json) and its bearer token, and answers in the shapes that file gives, checked the same way. They
// are not the real products: what passes here is tested against these fakes and those files only.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

type Doc = {
  version: string;
  operations: Record<string, { requestBody?: any; responses: Record<string, any> }>;
  components: { schemas: object; responses: Record<string, any> };
};
const siblings = JSON.parse(readFileSync(new URL("./siblings.json", import.meta.url), "utf8")) as Record<"audience" | "consent" | "crm" | "helpdesk", Doc>;

export const TOKENS = { consent: "consent-token-for-forms", audience: "audience-token-for-forms", crm: "crm-token-for-forms", helpdesk: "helpdesk-forms-key" };
export const HOOK_SECRET = "whsec_c2VjcmV0LWZvci10aGUtdGVzdHM=";
export const CAPTCHA_SECRET = "captcha-secret";

type Product = keyof typeof siblings;
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
for (const [p, doc] of Object.entries(siblings)) ajv.addSchema({ $id: `sibling:${p}`, components: doc.components, operations: doc.operations });

/** The schema of an operation's request body, or of one of its answers, as the product's openapi.json gives it. */
export function schemaOf(product: Product, operation: string, part: "request" | number): ValidateFunction {
  const op = siblings[product].operations[operation];
  if (!op) throw new Error(`${operation} is not in siblings.json for ${product}`);
  let schema: unknown;
  if (part === "request") schema = op.requestBody.content["application/json"].schema;
  else {
    let r = op.responses[String(part)];
    if (!r) throw new Error(`${product} ${operation} lists no ${part} answer`);
    if (r.$ref) r = siblings[product].components.responses[r.$ref.split("/").pop()];
    schema = (r.content["application/json"] ?? r.content["application/problem+json"]).schema;
  }
  const prefixed = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', `"sibling:${product}#/components/`));
  return ajv.compile(prefixed);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export interface Call {
  product: string;
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
  json: any;
}

export async function startFakes() {
  const state = {
    calls: [] as Call[],
    /** The next answers of a product, by status, before its usual one: [503] makes the next call fail once. */
    fail: { consent: [] as number[], audience: [] as number[], crm: [] as number[], helpdesk: [] as number[], hook: [] as number[] },
    purposes: [
      {
        id: "marketing",
        name: { en: "Offers and news", tr: "Kampanya ve duyurular" },
        channels: ["email", "sms"],
        current: 2,
        versions: [
          { version: 1, text: "Offers by email.", from: "2026-01-01", renew: false, granted: 10 },
          {
            version: 2,
            text: { en: "Offers, campaigns and news from Example by email and SMS.", tr: "Example'dan e-posta ve SMS ile kampanya ve duyurular." },
            from: "2026-06-01",
            renew: true,
            granted: 4,
          },
        ],
      },
    ],
    leads: new Map<string, string>(),
    tickets: new Map<string, number>(),
    captchaGood: "good-captcha-answer",
  };

  const validators = {
    consentRecord: schemaOf("consent", "POST /api/v1/consents", "request"),
    consentRecorded: schemaOf("consent", "POST /api/v1/consents", 201),
    consentPurposes: schemaOf("consent", "GET /api/v1/purposes", 200),
    audienceBatch: schemaOf("audience", "POST /api/v1/events", "request"),
    audienceResult: schemaOf("audience", "POST /api/v1/events", 200),
    lead: schemaOf("crm", "POST /api/v1/leads", "request"),
    leadCreated: schemaOf("crm", "POST /api/v1/leads", 201),
    ticket: schemaOf("helpdesk", "POST /api/v1/public/tickets", "request"),
    ticketCreated: schemaOf("helpdesk", "POST /api/v1/public/tickets", 201),
  };

  const send = (res: ServerResponse, status: number, data: unknown, check?: ValidateFunction) => {
    if (check && !check(data)) throw new Error(`the fake's own answer does not match openapi.json: ${JSON.stringify(check.errors)}`);
    const text = data === undefined ? "" : JSON.stringify(data);
    res
      .writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json", "content-length": Buffer.byteLength(text) })
      .end(text);
  };
  const problem = (res: ServerResponse, status: number, code: string, detail: string) =>
    send(res, status, { type: `https://openasy.github.io/problems/${code}`, title: code, status, code, detail });
  /** A request the product's openapi.json would refuse is answered 422, with what is wrong. */
  const refused = (res: ServerResponse, v: ValidateFunction, body: unknown) => {
    if (v(body)) return false;
    problem(res, 422, "invalid-body", `Not what openapi.json takes: ${JSON.stringify(v.errors)}`);
    return true;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const [, product, ...rest] = url.pathname.split("/");
    const path = `/${rest.join("/")}`;
    const raw = await readBody(req);
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    state.calls.push({ product: product!, method: req.method!, path, headers: req.headers, body: raw, json: body });
    const auth = req.headers.authorization;
    const failing = (state.fail as Record<string, number[]>)[product!];
    if (failing?.length) return problem(res, failing.shift()!, "unavailable", "The fake was told to fail.");
    const key = `${req.method} ${product}${path}`;
    try {
      switch (key) {
        case "GET consent/api/v1/purposes": {
          if (auth !== `Bearer ${TOKENS.consent}`) return problem(res, 401, "invalid-token", "Wrong token.");
          return send(
            res,
            200,
            {
              purposes: state.purposes.map((p) => ({ ...p, required: false, iys: true, byChannel: [], sites: [] })),
              file: { path: "/config/consent.yaml", appliedAt: "2026-11-01T00:00:00Z", purposes: state.purposes.length, sites: 1, error: null, warnings: [] },
            },
            validators.consentPurposes,
          );
        }
        case "POST consent/api/v1/consents": {
          if (auth !== `Bearer ${TOKENS.consent}`) return problem(res, 401, "invalid-token", "Wrong token.");
          if (refused(res, validators.consentRecord, body)) return;
          for (const a of body.answers) {
            const p = state.purposes.find((x) => x.id === a.purpose);
            if (!p) return problem(res, 422, "invalid-body", `${a.purpose} is not a purpose.`);
            if (!p.channels.includes(a.channel)) return problem(res, 422, "invalid-body", `${a.purpose} is not asked on ${a.channel}.`);
            if (a.version !== undefined && !p.versions.some((v) => v.version === a.version))
              return problem(res, 422, "invalid-body", `version ${a.version} does not exist.`);
          }
          return send(
            res,
            201,
            {
              person: "person-1",
              answers: body.answers.map((a: any, i: number) => ({
                id: i + 1,
                person: "person-1",
                purpose: a.purpose,
                channel: a.channel,
                version: a.version ?? 2,
                granted: a.granted,
                at: a.at ?? "2026-11-02T06:00:00Z",
                recordedAt: "2026-11-02T06:00:00Z",
                source: body.source ?? "api",
                via: body.via ?? null,
                actor: "token:forms",
                iysSource: null,
                proof: a.proof ?? null,
              })),
              standing: [],
            },
            validators.consentRecorded,
          );
        }
        case "POST audience/api/v1/events": {
          if (auth !== `Bearer ${TOKENS.audience}`) return problem(res, 401, "invalid-token", "Wrong token.");
          if (refused(res, validators.audienceBatch, body)) return;
          return send(
            res,
            200,
            {
              recorded: body.events.length,
              duplicates: 0,
              results: body.events.map((_: unknown, i: number) => ({
                profile: `profile-${i + 1}`,
                created: true,
                merged: [],
                conflicts: 0,
                event: i + 1,
                duplicate: false,
                ignoredTraits: [],
              })),
            },
            validators.audienceResult,
          );
        }
        case "POST crm/api/v1/leads": {
          if (auth !== `Bearer ${TOKENS.crm}`) return problem(res, 401, "invalid-token", "Wrong token.");
          if (refused(res, validators.lead, body)) return;
          const again = state.leads.get(body.external_id);
          const id = again ?? `deal-${state.leads.size + 1}`;
          state.leads.set(body.external_id, id);
          return send(
            res,
            again ? 200 : 201,
            { lead: { id, url: `https://crm.example.com/deals/${id}`, contact: body.email ? "contact-1" : null, created: !again } },
            validators.leadCreated,
          );
        }
        case "POST helpdesk/api/v1/public/tickets": {
          if (auth !== `Bearer ${TOKENS.helpdesk}`) return problem(res, 401, "invalid-token", "Wrong key.");
          if (refused(res, validators.ticket, body)) return;
          if (!body.email || !body.message) return problem(res, 422, "invalid-body", "email and message are required for forms.");
          const again = state.tickets.get(body.external_id);
          const number = again ?? 1040 + state.tickets.size + 1;
          state.tickets.set(body.external_id, number);
          return send(res, again ? 200 : 201, { ticket: { number, reference: `HD-${number}`, status: "open" }, created: !again }, validators.ticketCreated);
        }
        case "POST hook/in":
          return send(res, 200, { ok: true });
        case "POST captcha/siteverify": {
          const p = new URLSearchParams(raw);
          return send(res, 200, { success: p.get("secret") === CAPTCHA_SECRET && p.get("response") === state.captchaGood });
        }
      }
    } catch (err) {
      return problem(res, 500, "internal-error", String(err));
    }
    problem(res, 404, "not-found", `${key} is not faked.`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    state,
    calls: (product: string) => state.calls.filter((c) => c.product === product),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type Fakes = Awaited<ReturnType<typeof startFakes>>;
