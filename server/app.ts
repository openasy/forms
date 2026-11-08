import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Forms } from "./forms.ts";
import { pickLang } from "./forms.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import { formPage, missingPage } from "./page.ts";
import type { ProductLink } from "./products.ts";
import { FormsError, type Actor, type ProblemCode } from "./store.ts";

export interface AppOptions {
  db: DatabaseSync;
  forms: Forms;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** The address people open Forms at; its origin may always call the public API. */
  publicUrl: string;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** #rrggbb from the install's brand, for the form pages. */
  accent?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The built form script (dist/page/f.js), served at /embed.js for the form pages and other sites. */
  pageScript?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
  /** Behind a proxy: read the visitor's address from the last X-Forwarded-For entry, for rate limits. */
  trustProxy?: boolean;
}

function metricsText(forms: Forms, version: string) {
  return renderMetrics(version, forms.gauges(), !!forms.settings().file?.error);
}

/** Serves only /metrics, for a port that is not exposed with the rest (FORMS_METRICS_PORT). */
export function createMetricsHandler(forms: Forms, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(forms, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The team's pages run nothing from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; frame-src 'self'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer | Uint8Array, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "invalid-answers": "Some answers need a change",
  forbidden: "Forbidden",
  "forbidden-origin": "Origin not allowed",
  "not-found": "Not found",
  conflict: "Conflict",
  closed: "Closed",
  expired: "Expired",
  "proof-of-work": "Proof of work missing",
  "captcha-failed": "Captcha not solved",
  "unsupported-file": "File type not taken",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(
  res: ServerResponse,
  status: number,
  code: ProblemCode,
  detail?: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }), ...extra };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  // A body too large is read to its end and dropped, so the answer reaches a client still sending and the
  // connection stays usable; past four times the limit the connection is cut.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new FormsError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = (await readRaw(req, limit)).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new FormsError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A file someone attached: only plain images are shown inline, anything else is downloaded, and nothing in it can run. */
function sendFile(res: ServerResponse, f: { name: string; type: string; data: Uint8Array }) {
  const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.type);
  send(res, 200, f.data, inline ? f.type : f.type === "text/plain" ? "text/plain; charset=utf-8" : "application/octet-stream", {
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  });
}

/** The role a route needs (ADR 0003); "none" for what anyone may call. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  address: string;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  path: string;
  auth: Access;
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

const CAPTCHA_ORIGINS = { turnstile: "https://challenges.cloudflare.com", hcaptcha: "https://hcaptcha.com https://*.hcaptcha.com" };

export function createApp({
  db,
  forms,
  version,
  auth,
  publicUrl,
  adminToken,
  accent = "#2f5bd3",
  webDir,
  docsDir,
  pageScript,
  openapi,
  serveMetrics = true,
  products = [],
  trustProxy = false,
}: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const own = new URL(publicUrl).origin;
  const noContent = (res: ServerResponse, headers: Record<string, string> = {}) => {
    res.writeHead(204, { ...SECURITY_HEADERS, ...headers }).end();
  };
  const P = "/api/v1";

  const routes: Route[] = [
    { method: "GET", path: `${P}/version`, auth: "none", handle: () => ({ product: "forms", version }) },
    { method: "GET", path: `${P}/products`, auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: `${P}/summary`, auth: "viewer", handle: () => forms.summary() },
    // The settings, as the file sets them. There is no route that changes them, nor a form.
    { method: "GET", path: `${P}/settings`, auth: "viewer", handle: () => forms.settings() },
    { method: "GET", path: `${P}/integrations`, auth: "viewer", handle: () => forms.integrations() },

    { method: "GET", path: `${P}/forms`, auth: "viewer", handle: () => ({ forms: forms.listForms() }) },
    { method: "GET", path: `${P}/forms/:id`, auth: "viewer", handle: ({ params, url }) => forms.getForm(params[0]!, url.searchParams.get("lang")) },
    { method: "GET", path: `${P}/forms/:id/responses`, auth: "viewer", handle: ({ params, url }) => forms.listResponses(params[0]!, url.searchParams) },
    {
      method: "GET",
      path: `${P}/forms/:id/export`,
      auth: "viewer",
      handle: ({ res, params, url }) => {
        const r = forms.exportCsv(params[0]!, url.searchParams);
        send(res, 200, r.csv, "text/csv; charset=utf-8", { "content-disposition": `attachment; filename="${r.filename}"`, "cache-control": "no-store" });
      },
    },
    { method: "GET", path: `${P}/forms/:id/report`, auth: "viewer", handle: ({ params, url }) => forms.report(params[0]!, url.searchParams) },

    { method: "GET", path: `${P}/responses/:id`, auth: "viewer", handle: ({ params }) => forms.getResponse(params[0]!) },
    { method: "POST", path: `${P}/responses/:id/spam`, auth: "editor", handle: ({ who, params }) => forms.setSpam(who, params[0]!, true) },
    { method: "POST", path: `${P}/responses/:id/not-spam`, auth: "editor", handle: ({ who, params }) => forms.setSpam(who, params[0]!, false) },
    { method: "POST", path: `${P}/responses/:id/retry`, auth: "editor", handle: ({ params }) => forms.retry(params[0]!) },
    { method: "DELETE", path: `${P}/responses/:id`, auth: "editor", handle: ({ res, params }) => (forms.removeResponse(params[0]!), noContent(res)) },
    { method: "GET", path: `${P}/files/:id`, auth: "viewer", handle: ({ res, params }) => sendFile(res, forms.file(params[0]!)) },

    // What Audience calls when a person is deleted on request.
    { method: "POST", path: `${P}/erasures`, auth: "admin", handle: async ({ body }) => forms.erase(await body()) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function addressOf(req: IncomingMessage) {
    const xff = trustProxy ? (req.headers["x-forwarded-for"] as string | undefined)?.split(",").pop()?.trim() : undefined;
    return xff || req.socket.remoteAddress || "";
  }

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous", role: "viewer" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token", role: "admin" };
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: p.user.id, name: p.user.name, role: p.role } : { id: `token:${p.tokenId}`, name: p.name, role: p.role };
  }

  // ---------------------------------------------------------------- what pages and other sites call

  /** CORS for a form's public API: its own pages, and the origins its embed lists. */
  function corsFor(req: IncomingMessage, form: string): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin || origin === own) return { vary: "Origin" };
    const def = forms.config()?.forms.find((f) => f.id === form);
    if (!def || !def.embed.includes(origin))
      throw new FormsError(403, "forbidden-origin", "This page's origin is not in the form's embed list in the settings file.");
    return { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "retry-after" };
  }

  async function publicApi(req: IncomingMessage, res: ServerResponse, url: URL, m: RegExpExecArray): Promise<string> {
    const [, id, rest = ""] = m;
    const name = `${P}/public/forms/{id}${rest}`;
    let cors: Record<string, string> = { vary: "Origin" };
    try {
      cors = corsFor(req, id!);
      if (req.method === "OPTIONS") {
        noContent(res, {
          ...cors,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type, x-file-name",
          "access-control-max-age": "600",
        });
        return name;
      }
      const address = addressOf(req);
      const ctx = { address, origin: req.headers.origin };
      const key = `${req.method} ${rest}`;
      if (key === "GET ") {
        const lang = pickLang(req.headers["accept-language"], url.searchParams.get("lang"), forms.languages(id!), forms.config()!.language);
        json(res, 200, forms.publicForm(id!, lang, true), { ...cors, "cache-control": "no-store" });
      } else if (key === "POST /responses") {
        const r = await forms.submit(id!, await readJson(req, 256 * 1024), ctx);
        json(res, r.status, r.body, cors);
      } else if (key === "POST /progress") {
        forms.progress(id!, await readJson(req, 128 * 1024), ctx);
        noContent(res, cors);
      } else if (key === "POST /files") {
        forms.formDef(id!);
        const raw = await readRaw(req, 20 * 1024 * 1024);
        const fileName = req.headers["x-file-name"];
        json(res, 201, forms.upload(id!, url.searchParams, raw, typeof fileName === "string" ? decodeURIComponent(fileName) : undefined, ctx), cors);
      } else throw new FormsError(404, "not-found", "Not found.");
    } catch (err) {
      if (!(err instanceof FormsError)) throw err;
      problem(
        res,
        err.status,
        err.code,
        err.message,
        { ...cors, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) },
        err.errors ? { errors: err.errors } : {},
      );
      if (!req.complete) req.resume();
    }
    return name;
  }

  let built: { at: number; text: string | null } = { at: 0, text: null };
  async function script(res: ServerResponse) {
    if (!built.text || Date.now() - built.at > 60_000)
      built = { at: Date.now(), text: pageScript ? await readFile(pageScript, "utf8").catch(() => null) : null };
    const headers = { "cache-control": "public, max-age=300", "cross-origin-resource-policy": "cross-origin", "access-control-allow-origin": "*" };
    if (!built.text) return send(res, 503, "/* OpenAsy Forms: the form script is not built. */\n", "text/javascript; charset=utf-8", headers);
    send(res, 200, built.text, "text/javascript; charset=utf-8", headers);
  }

  /** The form's own page: one form, with the install's accent, Analytics' script when the file names one. */
  function page(req: IncomingMessage, res: ServerResponse, url: URL, id: string) {
    const c = forms.config();
    const def = c?.forms.find((f) => f.id === id);
    if (!c || !def) return send(res, 404, missingPage(), TYPES[".html"]!, { "cache-control": "no-store" });
    const lang = pickLang(req.headers["accept-language"], url.searchParams.get("lang"), forms.languages(id), c.language);
    const analytics = c.analytics ? new URL(c.analytics).origin : null;
    const captcha = def.spam.captcha && c.captcha ? CAPTCHA_ORIGINS[c.captcha.provider] : null;
    const preview = url.searchParams.get("preview") === "1";
    const csp = [
      "default-src 'none'",
      `script-src 'self'${analytics ? ` ${analytics}` : ""}${captcha ? ` ${captcha}` : ""}`,
      `connect-src 'self'${analytics ? ` ${analytics}` : ""}${captcha ? ` ${captcha}` : ""}`,
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      ...(captcha ? [`frame-src ${captcha}`] : []),
      "form-action 'self'",
      "base-uri 'none'",
      `frame-ancestors 'self'${preview ? "" : def.embed.map((o) => ` ${o}`).join("")}`,
    ].join("; ");
    const p = forms.publicForm(id, lang, !preview && req.method === "GET");
    const html = formPage({ form: p, lang, accent, analytics: preview ? null : c.analytics, preview, framed: url.searchParams.get("frame") === "1" });
    // Framed only by Forms itself (the preview) and the form's embed origins, as frame-ancestors says.
    const { "x-frame-options": _, ...headers } = SECURITY_HEADERS;
    res.writeHead(200, {
      ...headers,
      "content-type": TYPES[".html"]!,
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
      "content-security-policy": csp,
      // The page's address goes to Analytics as the page viewed; its query (prefilled answers) is never sent on.
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    res.end(req.method === "HEAD" ? undefined : html);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!forms.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(forms, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (path === "/embed.js" && (req.method === "GET" || req.method === "HEAD")) return (await script(res), "/embed.js");
    const fp = /^\/f\/([a-z][a-z0-9-]{0,39})$/.exec(path);
    if (fp && (req.method === "GET" || req.method === "HEAD")) return (page(req, res, url, fp[1]!), "/f/{id}");

    const pub = /^\/api\/v1\/public\/forms\/([a-z][a-z0-9-]{0,39})(\/responses|\/progress|\/files)?$/.exec(path);
    if (pub) return publicApi(req, res, url, pub);

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, address: addressOf(req), body: () => readJson(req, r.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof FormsError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Form pages and their API come with the sites' traffic, and their queries can hold answers; only the route is logged.
    if (!["/healthz", "/metrics", "/embed.js"].includes(routeName)) {
      log("info", "request", {
        method: req.method,
        path: routeName.includes("{id}") ? routeName : (req.url ?? "/").split("?")[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      });
    }
  };
}
