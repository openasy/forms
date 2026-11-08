// Copies the parts of the other products' openapi.json that Forms calls into server/siblings.json, so the fakes the
// tests run against check requests and answer in exactly the shapes those products publish. Run it from a checkout
// with the other products next to this one (../audience, ../consent, ../crm, ../helpdesk) after one of them changes
// its API; a test compares the copy with the products' files whenever they are there.
import { readFileSync, writeFileSync } from "node:fs";

/** The operations Forms calls, and the one it answers (Audience's erasure webhook). */
export const CALLS = {
  audience: [
    ["/api/v1/events", "post"],
    ["webhooks:erasure", "post"],
  ],
  consent: [
    ["/api/v1/consents", "post"],
    ["/api/v1/purposes", "get"],
  ],
  crm: [["/api/v1/leads", "post"]],
  helpdesk: [["/api/v1/public/tickets", "post"]],
} as const;

type Doc = {
  info: { version: string };
  paths: Record<string, any>;
  webhooks?: Record<string, any>;
  components: { schemas: Record<string, unknown>; responses?: Record<string, unknown> };
};

/** The operations and every schema they reach, from one product's openapi.json. */
export function extract(doc: Doc, calls: ReadonlyArray<readonly [string, string]>) {
  const operations: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  const responses: Record<string, unknown> = {};
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "$ref" && typeof x === "string") {
        const [, kind, name] = /^#\/components\/(schemas|responses)\/(.+)$/.exec(x) ?? [];
        const into = kind === "schemas" ? schemas : responses;
        const from = kind === "schemas" ? doc.components.schemas : (doc.components.responses ?? {});
        if (name && !(name in into)) {
          into[name] = from[name];
          walk(from[name]);
        }
      } else walk(x);
    }
  };
  for (const [path, method] of calls) {
    const op = path.startsWith("webhooks:") ? doc.webhooks?.[path.slice(9)]?.[method] : doc.paths[path]?.[method];
    if (!op) throw new Error(`${path} ${method} is not in the file`);
    operations[`${method.toUpperCase()} ${path}`] = { requestBody: op.requestBody, responses: op.responses };
    walk(op);
  }
  return { version: doc.info.version, operations, components: { schemas, responses } };
}

export function read(product: string): Doc {
  return JSON.parse(readFileSync(new URL(`../../${product}/openapi.json`, import.meta.url), "utf8")) as Doc;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const out: Record<string, unknown> = {};
  for (const [product, calls] of Object.entries(CALLS)) out[product] = extract(read(product), calls);
  writeFileSync(new URL("../server/siblings.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  console.log("server/siblings.json written");
}
