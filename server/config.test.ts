import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings, parseConfig, pick, watchConfig } from "./config.ts";
import { check, shown, validate, type PublicField, type PublicForm } from "./logic.ts";

describe("forms.yaml", () => {
  it("reads one form from each file of the forms folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "forms-folder-"));
    const path = join(dir, "forms.yaml");
    writeFileSync(path, "language: tr\nforms: { contact: { fields: [{ id: email, type: email, label: E }] } }");
    mkdirSync(join(dir, "forms"));
    writeFileSync(join(dir, "forms", "demo.yaml"), "name: Demo\nkind: lead\nfields: [{ id: email, type: email, label: E }]\n");
    const got: Array<{ ids: string[]; files: string[] }> = [];
    const w = watchConfig(path, (c, _t, files) => (got.push({ ids: c.forms.map((f) => `${f.id}@${f.file}`), files: files.map((f) => f.name) }), []), {
      everyMs: 3_600_000,
    });
    expect(got).toEqual([{ ids: ["contact@forms.yaml", "demo@forms/demo.yaml"], files: ["demo.yaml"] }]);
    writeFileSync(join(dir, "forms", "contact.yaml"), "fields: [{ id: a, label: A }]\n");
    w.read();
    expect(w.state.error).toBe("forms/contact.yaml: the form contact is also in forms.yaml.");
    writeFileSync(join(dir, "forms", "contact.yaml"), "fields: [{ id: a, type: radio, label: A }]\n");
    expect(() => parseConfig("", [{ name: "x.yaml", text: "fields: [{ id: a, type: radio, label: A }]" }])).toThrow("forms/x.yaml.fields[0].type is one of");
    w.stop();
  });

  it("reads the example file", () => {
    const c = parseConfig(readFileSync(new URL("../config/forms.yaml", import.meta.url), "utf8"));
    expect(c.forms.map((f) => [f.id, f.kind, f.pages.length])).toEqual([
      ["demo", "lead", 3],
      ["contact", "contact", 1],
      ["nps", "nps", 1],
    ]);
    const demo = c.forms[0]!;
    expect(demo.person).toEqual({ email: "email", phone: null, name: "name", company: "company", userId: null });
    expect(demo.pages[1]!.showIf).toEqual([{ field: "size", in: ["51-200", "200+"] }]);
    expect(demo.send.crm?.ownerBy?.owners.emea).toBe("emily@example.com");
    expect(demo.spam).toMatchObject({ minSeconds: 3, rate: { n: 5, perMs: 60_000 }, proofOfWork: null });
    expect(demo.partials).toBe("progress");
    expect(c.forms[2]!.partials).toBe("off");
    expect(pick(demo.title, "tr", "en")).toBe("Demo isteyin");
  });

  it("has defaults for an empty file", () => {
    const c = parseConfig("");
    expect(c.forms).toEqual([]);
    expect(c.language).toBe("en");
    expect(c.keep).toEqual({ partialDays: 30, spamDays: 30, responseDays: null });
  });

  it("names the field to fix", () => {
    const bad = (yaml: string) => {
      try {
        parseConfig(yaml);
        return "applied";
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(bad("nope: 1")).toContain("The file: unknown nope");
    expect(bad("forms: { Demo: { fields: [{ id: a, label: A }] } }")).toContain("forms.Demo: a form id");
    expect(bad("forms: { demo: { fields: [{ id: a, type: radio, label: A }] } }")).toContain("forms.demo.fields[0].type is one of");
    expect(bad("forms: { demo: { fields: [{ id: a, label: A }, { id: a, label: B }] } }")).toContain("a is used twice");
    expect(bad("forms: { demo: { fields: [{ id: a, label: A, show_if: { field: b, is: x } }, { id: b, label: B }] } }")).toContain(
      "forms.demo.fields[0].show_if.field: b is not a hidden field or a field before this one",
    );
    expect(bad("forms: { demo: { fields: [{ id: a, type: choice, label: A }] } }")).toContain("forms.demo.fields[0].options is a list");
    expect(
      bad("forms: { demo: { fields: [{ id: e, type: email, label: E }, { id: c, type: consent, purpose: marketing, channels: [fax], label: C }] } }"),
    ).toContain("channels is a list of email, sms, call and web");
    expect(bad("forms: { demo: { fields: [{ id: c, type: consent, purpose: marketing, label: C }] } }")).toContain(
      "a consent box needs an email or phone field",
    );
    expect(bad("forms: { demo: { fields: [{ id: f, type: file, label: F, types: [exe] }] } }")).toContain("exe is not one of");
    expect(bad("forms: { demo: { fields: [{ id: f, type: file, label: F, max_size: 50MB }] } }")).toContain("max_size is 1KB to 20MB");
    expect(bad("forms: { demo: { kind: nps, fields: [{ id: a, label: A }] } }")).toContain("an nps form needs a field of type nps");
    expect(bad("forms: { demo: { fields: [{ id: a, label: A }], send_to: { helpdesk: true } } }")).toContain("Helpdesk replies by email");
    expect(bad("forms: { demo: { fields: [{ id: a, label: A }], send_to: { webhooks: [zap] } } }")).toContain("zap is not under webhooks");
    expect(bad("forms: { demo: { fields: [{ id: a, label: A }], spam: { rate: lots } } }")).toContain("forms.demo.spam.rate is answers from one address");
    expect(parseConfig("forms: { demo: { fields: [{ id: a, label: A }], spam: { rate: 5/10m } } }").forms[0]!.spam.rate).toEqual({
      n: 5,
      perMs: 600_000,
      text: "5/10m",
    });
    expect(bad("forms: { demo: { fields: [{ id: a, label: A }], embed: [https://x.example/path] } }")).toContain("forms.demo.embed[0] is an origin");
    expect(bad("audience: { url: http://audience.example.com }")).toContain("audience.url is an https:// address");
    expect(bad("crm: { url: https://crm.example.com, token: abc123 }")).toContain("crm.token is the name of an environment variable");
    expect(bad("analytics: https://analytics.example.com/script.js")).toContain("analytics is the script of an Analytics site");
    expect(bad("forms: { demo: { fields: [{ id: a, label: A }], pages: [] } }")).toContain("fields (one page) or pages, not both");
    expect(bad("forms: { demo: { hidden: [h], pages: [{ fields: [{ id: a, label: A }], show_if: { field: h, answered: true } }] } }")).toContain(
      "the first page is always shown",
    );
  });

  it("warns about secrets not set and links a form needs", () => {
    const c = parseConfig(`
crm: { url: http://crm:8080 }
forms:
  demo:
    fields: [{ id: email, type: email, label: E }, { id: c, type: consent, purpose: marketing, label: C }]
    send_to: { crm: true, helpdesk: true, notify: [a@example.com] }
`);
    expect(configWarnings(c, {})).toEqual([
      "crm: FORMS_CRM_TOKEN is not set, so nothing is sent to Crm.",
      "forms.demo.send_to.helpdesk: helpdesk is not linked in the file, so its answers stay in Forms.",
      "forms.demo.send_to.notify: there is no mail server under mail, so nobody is told.",
      "forms.demo: it has a consent box but consent is not linked, so ticked boxes are kept in Forms only.",
    ]);
  });

  it("applies a new file within the poll, and keeps the last good one when it has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "forms-config-"));
    const path = join(dir, "forms.yaml");
    writeFileSync(path, "forms: { a: { fields: [{ id: x, label: X }] } }");
    const applied: string[][] = [];
    const w = watchConfig(path, (c) => (applied.push(c.forms.map((f) => f.id)), []), { everyMs: 3_600_000 });
    expect(applied).toEqual([["a"]]);
    writeFileSync(path, "forms: { a: { fields: [] } }");
    w.read();
    expect(w.state.error).toContain("forms.a.fields is a list of 1 to 50 fields");
    writeFileSync(path, "forms: { b: { fields: [{ id: x, label: X }] } }");
    w.read();
    expect(applied).toEqual([["a"], ["b"]]);
    expect(w.state.error).toBeNull();
    w.stop();
  });
});

const field = (over: Partial<PublicField>): PublicField => ({
  id: "x",
  type: "text",
  label: "X",
  help: null,
  placeholder: null,
  required: false,
  min: null,
  max: null,
  pattern: null,
  patternMessage: null,
  options: [],
  minLabel: null,
  maxLabel: null,
  accept: [],
  maxSize: null,
  consent: null,
  showIf: [],
  ...over,
});

describe("answers", () => {
  it("checks each type", () => {
    expect(check(field({ required: true }), "  ")).toEqual({ error: "required" });
    expect(check(field({ type: "email" }), "Ada@Example.COM ")).toEqual({ value: "ada@example.com" });
    expect(check(field({ type: "email" }), "ada@")).toEqual({ error: "email" });
    expect(check(field({ type: "phone" }), "0532 000 00 12")).toEqual({ value: "0532 000 00 12" });
    expect(check(field({ type: "phone" }), "call me")).toEqual({ error: "phone" });
    expect(check(field({ type: "url" }), "javascript:alert(1)")).toEqual({ error: "url" });
    expect(check(field({ type: "number", min: 1, max: 10 }), "3,5")).toEqual({ value: 3.5 });
    expect(check(field({ type: "number", min: 1 }), 0)).toEqual({ error: "too_small" });
    expect(check(field({ type: "nps" }), 11)).toEqual({ error: "too_large" });
    expect(check(field({ type: "rating", max: 5 }), "4")).toEqual({ value: 4 });
    expect(check(field({ type: "date" }), "2026-02-30")).toEqual({ error: "date" });
    expect(check(field({ type: "text", pattern: "^TR\\d{2}" }), "DE12")).toEqual({ error: "pattern" });
    expect(check(field({ type: "text", min: 3 }), "ab")).toEqual({ error: "too_short" });
    const opts = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ];
    expect(check(field({ type: "choice", options: opts }), "d")).toEqual({ error: "option" });
    expect(check(field({ type: "choices", options: opts, max: 2 }), ["c", "a"])).toEqual({ value: ["a", "c"] });
    expect(check(field({ type: "choices", options: opts, max: 1 }), ["c", "a"])).toEqual({ error: "too_many" });
    expect(check(field({ type: "yes_no" }), "no")).toEqual({ value: false });
    // An unticked box is no, and is never kept; a required one must be ticked.
    expect(check(field({ type: "consent" }), false)).toEqual({});
    expect(check(field({ type: "consent", required: true }), false)).toEqual({ error: "required" });
    expect(check(field({ type: "consent" }), true)).toEqual({ value: true });
    expect(check(field({ type: "file" }), "../../etc/passwd")).toEqual({ error: "file" });
  });

  it("shows pages and fields by show_if, and drops answers on what is not shown", () => {
    const form: Pick<PublicForm, "pages" | "hidden"> = {
      hidden: ["plan"],
      pages: [
        {
          title: null,
          description: null,
          showIf: [],
          fields: [
            field({
              id: "size",
              type: "choice",
              options: [
                { value: "small", label: "S" },
                { value: "big", label: "B" },
              ],
              required: true,
            }),
          ],
        },
        {
          title: null,
          description: null,
          showIf: [{ field: "size", is: "big" }],
          fields: [
            field({ id: "region", required: true }),
            field({
              id: "deal",
              showIf: [
                {
                  any: [
                    { field: "plan", is: "pro" },
                    { field: "region", is: "emea" },
                  ],
                },
              ],
            }),
          ],
        },
        {
          title: null,
          description: null,
          showIf: [],
          fields: [field({ id: "score", type: "nps" }), field({ id: "why", showIf: [{ field: "score", below: 7 }] })],
        },
      ],
    };
    expect(shown(form, { size: "small" }).pages).toEqual([0, 2]);
    expect(validate(form, { size: "small", region: "x" }).answers).toEqual({ size: "small" });
    expect(validate(form, { size: "big" }).errors).toEqual([{ field: "region", code: "required" }]);
    expect(shown(form, { size: "big", region: "emea" }).fields.map((f) => f.id)).toEqual(["size", "region", "deal", "score"]);
    expect(shown(form, { size: "big", region: "us", plan: "pro" }).fields.map((f) => f.id)).toContain("deal");
    expect(shown(form, { size: "small", score: "6" }).fields.map((f) => f.id)).toContain("why");
    expect(shown(form, { size: "small", score: 9 }).fields.map((f) => f.id)).not.toContain("why");
    // An invalid answer opens nothing.
    expect(shown(form, { size: "huge" }).pages).toEqual([0, 2]);
    // Only the pages up to upTo are checked, as Next checks a page.
    expect(validate(form, {}, 0).errors).toEqual([{ field: "size", code: "required" }]);
  });
});
