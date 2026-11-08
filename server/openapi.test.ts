import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import { CALLS, extract, read } from "../scripts/siblings.ts";
import { ADMIN_TOKEN, startApp, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "forms-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");
const scriptFile = join(docsDir, "f.js");
writeFileSync(scriptFile, "/* the form script */");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir, pageScript: scriptFile });
  base = app.base;
});
afterAll(() => app.close());

let ip = 0;
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const headers = { "x-forwarded-for": `10.20.${ip++ % 250}.1`, ...(init.headers as Record<string, string>) };
  const res = await fetch(base + concrete, { ...init, headers, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (!type.endsWith("json")) return { res, body: (await res.text()) as any };
  const body = await res.json();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
const anon = (b?: unknown, headers: Record<string, string> = {}) => ({
  headers: { "content-type": "application/json", ...headers },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/ and the form script at /embed.js", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
    const js = await fetch(`${base}/embed.js`);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});

describe("the other products' contracts", () => {
  // siblings.json is what the fakes check Forms' requests with. Where the other products are checked out next to this
  // one, it must be what their openapi.json says now.
  const here = existsSync(new URL("../../audience/openapi.json", import.meta.url));
  it.skipIf(!here)("siblings.json is what the other products' openapi.json say", () => {
    const copy = JSON.parse(readFileSync(new URL("./siblings.json", import.meta.url), "utf8")) as Record<string, unknown>;
    for (const [product, calls] of Object.entries(CALLS))
      expect(copy[product], `${product}: run node scripts/siblings.ts`).toEqual(extract(read(product), calls));
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of ["/api/v1/products", "/api/v1/summary", "/api/v1/settings", "/api/v1/integrations", "/api/v1/forms"]) {
      await call("GET", p, admin());
      await call("GET", p, {});
    }
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("the public API", async () => {
    const f = await call("GET", "/api/v1/public/forms/{id}", anon(), "/api/v1/public/forms/demo?lang=tr");
    await call("GET", "/api/v1/public/forms/{id}", anon(), "/api/v1/public/forms/nope");
    await call("GET", "/api/v1/public/forms/{id}", anon(undefined, { origin: "https://evil.example" }), "/api/v1/public/forms/demo");
    const token = f.body.token as string;
    app.clock.advance(5000);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 32)]);
    const files = (q: Record<string, string>) => `/api/v1/public/forms/demo/files?${new URLSearchParams(q)}`;
    const up = await call("POST", "/api/v1/public/forms/{id}/files", { body: pdf, headers: { "x-file-name": "brief.pdf" } }, files({ token, field: "cv" }));
    ids.file = up.body.id;
    await call("POST", "/api/v1/public/forms/{id}/files", { body: Buffer.from("<html></html>") }, files({ token, field: "cv" }));
    await call("POST", "/api/v1/public/forms/{id}/files", { body: Buffer.alloc(200 * 1024, 32) }, files({ token, field: "cv" }));
    await call("POST", "/api/v1/public/forms/{id}/files", { body: pdf }, files({ token, field: "name" }));
    await call("POST", "/api/v1/public/forms/{id}/files", { body: pdf }, "/api/v1/public/forms/nope/files");
    await call("POST", "/api/v1/public/forms/{id}/files", { body: pdf, headers: { origin: "https://evil.example" } }, files({ token, field: "cv" }));

    await call("POST", "/api/v1/public/forms/{id}/progress", anon({ token, page: 1, pages: [0, 1], answered: ["name"] }), "/api/v1/public/forms/demo/progress");
    await call("POST", "/api/v1/public/forms/{id}/progress", anon({ token: "x.y.z", page: 0 }), "/api/v1/public/forms/demo/progress");
    await call("POST", "/api/v1/public/forms/{id}/progress", anon({ token, extra: 1 }), "/api/v1/public/forms/demo/progress");
    await call("POST", "/api/v1/public/forms/{id}/progress", anon({ token }), "/api/v1/public/forms/nope/progress");
    await call("POST", "/api/v1/public/forms/{id}/progress", anon("{"), "/api/v1/public/forms/demo/progress");
    await call("POST", "/api/v1/public/forms/{id}/progress", anon({ token }, { origin: "https://evil.example" }), "/api/v1/public/forms/demo/progress");

    const answers = { name: "Ada", email: "ada@example.com", size: "200+", region: "emea", cv: ids.file, marketing: true };
    const sent = await call(
      "POST",
      "/api/v1/public/forms/{id}/responses",
      anon({ token, answers, versions: { marketing: 2 } }),
      "/api/v1/public/forms/demo/responses",
    );
    ids.response = sent.body.response.id;
    await call("POST", "/api/v1/public/forms/{id}/responses", anon({ token, answers }), "/api/v1/public/forms/demo/responses");
    const f2 = (await (await app.visitor("/api/v1/public/forms/demo")).json()) as { token: string };
    app.clock.advance(5000);
    await call("POST", "/api/v1/public/forms/{id}/responses", anon({ token: f2.token, answers: { name: "" } }), "/api/v1/public/forms/demo/responses");
    await call("POST", "/api/v1/public/forms/{id}/responses", anon({ token: f2.token, answers: "x" }), "/api/v1/public/forms/demo/responses");
    await call("POST", "/api/v1/public/forms/{id}/responses", anon("{"), "/api/v1/public/forms/demo/responses");
    await call("POST", "/api/v1/public/forms/{id}/responses", anon({ token: f2.token, answers: {} }), "/api/v1/public/forms/nope/responses");
    await call(
      "POST",
      "/api/v1/public/forms/{id}/responses",
      anon({ token: f2.token, answers: {} }, { origin: "https://evil.example" }),
      "/api/v1/public/forms/demo/responses",
    );
    await call(
      "POST",
      "/api/v1/public/forms/{id}/responses",
      { body: JSON.stringify({ token: f2.token, answers: { a: "x".repeat(300 * 1024) } }) },
      "/api/v1/public/forms/demo/responses",
    );
    for (let i = 0; i < 6; i++)
      await call(
        "POST",
        "/api/v1/public/forms/{id}/responses",
        anon({ token: f2.token, answers: { email: "x" } }, { "x-forwarded-for": "10.99.0.1" }),
        "/api/v1/public/forms/support/responses",
      );
    await app.forms.flush();
  });

  it("forms and answers", async () => {
    await call("GET", "/api/v1/forms/{id}", admin(), "/api/v1/forms/demo?lang=tr");
    await call("GET", "/api/v1/forms/{id}", admin(), "/api/v1/forms/nope");
    await call("GET", "/api/v1/forms/{id}/responses", admin(), "/api/v1/forms/demo/responses?status=all&limit=1");
    await call("GET", "/api/v1/forms/{id}/responses", admin(), "/api/v1/forms/demo/responses?status=maybe");
    await call("GET", "/api/v1/forms/{id}/responses", admin(), "/api/v1/forms/nope/responses");
    await call("GET", "/api/v1/forms/{id}/export", admin(), "/api/v1/forms/demo/export?status=all");
    await call("GET", "/api/v1/forms/{id}/export", admin(), "/api/v1/forms/demo/export?from=yesterday");
    await call("GET", "/api/v1/forms/{id}/export", admin(), "/api/v1/forms/nope/export");
    await call("GET", "/api/v1/forms/{id}/report", admin(), "/api/v1/forms/demo/report?from=2026-11-01");
    await call("GET", "/api/v1/forms/{id}/report", admin(), "/api/v1/forms/demo/report?to=11.11.2026");
    await call("GET", "/api/v1/forms/{id}/report", admin(), "/api/v1/forms/nope/report");
    await call("GET", "/api/v1/forms/{id}/report", {}, "/api/v1/forms/demo/report");
    await call("GET", "/api/v1/responses/{id}", admin(), `/api/v1/responses/${ids.response}`);
    await call("GET", "/api/v1/responses/{id}", admin(), "/api/v1/responses/missing");
    await call("GET", "/api/v1/files/{id}", admin(), `/api/v1/files/${ids.file}`);
    await call("GET", "/api/v1/files/{id}", admin(), "/api/v1/files/missing");
    await call("POST", "/api/v1/responses/{id}/spam", admin(), `/api/v1/responses/${ids.response}/spam`);
    await call("POST", "/api/v1/responses/{id}/spam", admin(), "/api/v1/responses/missing/spam");
    await call("POST", "/api/v1/responses/{id}/not-spam", admin(), `/api/v1/responses/${ids.response}/not-spam`);
    await call("POST", "/api/v1/responses/{id}/not-spam", admin(), "/api/v1/responses/missing/not-spam");
    const partial = app.db.prepare("SELECT id FROM responses WHERE status = 'partial' LIMIT 1").get() as { id: string } | undefined;
    if (partial) await call("POST", "/api/v1/responses/{id}/spam", admin(), `/api/v1/responses/${partial.id}/spam`);
    await call("POST", "/api/v1/responses/{id}/retry", admin(), `/api/v1/responses/${ids.response}/retry`);
    await call("POST", "/api/v1/responses/{id}/retry", admin(), "/api/v1/responses/missing/retry");
    await call("DELETE", "/api/v1/responses/{id}", admin(), `/api/v1/responses/${ids.response}`);
    await call("DELETE", "/api/v1/responses/{id}", admin(), `/api/v1/responses/${ids.response}`);
    await call("DELETE", "/api/v1/responses/{id}", {}, `/api/v1/responses/${ids.response}`);
  });

  it("what Audience calls", async () => {
    await call(
      "POST",
      "/api/v1/erasures",
      admin({ reference: "KVKK-1", product: "audience", people: { emails: ["ada@example.com"], phones: [], userIds: [] } }),
    );
    await call("POST", "/api/v1/erasures", admin({ reference: "KVKK-2", product: "audience" }));
    await call("POST", "/api/v1/erasures", admin("{"));
    await call("POST", "/api/v1/erasures", anon({}));
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
