import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOOK_SECRET, TOKENS } from "./fakes.ts";
import { DAY } from "./store.ts";
import { SETTINGS, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

const demo = {
  name: "Gizem Avcı",
  email: "Gizem@Avci.example",
  company: "Avcı Lojistik",
  size: "51-200",
  region: "apac",
  message: "We are 120 people.",
  marketing: true,
  plan: "business",
};

describe("the form a page draws", () => {
  it("is in the page's language, with the consent box's text from Consent", async () => {
    const r = await app.visitor("/api/v1/public/forms/demo", { headers: { "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" } });
    expect(r.status).toBe(200);
    const f = (await r.json()) as any;
    expect(f).toMatchObject({ id: "demo", language: "tr", title: "Demo isteyin", hidden: ["plan"], partials: "progress", closed: null });
    expect(f.pages[0].title).toBe("Sizi tanıyalım");
    const box = f.pages[2].fields[1];
    expect(box).toMatchObject({
      type: "consent",
      label: "Example'dan e-posta ve SMS ile kampanya ve duyurular.",
      consent: { purpose: "marketing", channels: ["email"], version: 2 },
    });
    expect(f.spam).toEqual({ honeypot: "website", proofOfWork: null, captcha: null });
    expect(f.token).toMatch(/^[a-z0-9]+\.[\w-]+\.[\w-]+$/);
  });

  it("answers pages on the form's embed origins only", async () => {
    const ok = await app.visitor("/api/v1/public/forms/demo", { headers: { origin: "https://www.example.com" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://www.example.com");
    const other = await app.visitor("/api/v1/public/forms/demo", { headers: { origin: "https://evil.example" } });
    expect(other.status).toBe(403);
    expect(((await other.json()) as any).code).toBe("forbidden-origin");
    const pre = await app.visitor("/api/v1/public/forms/demo/responses", { method: "OPTIONS", headers: { origin: "https://www.example.com" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect((await app.visitor("/api/v1/public/forms/support", { headers: { origin: "https://www.example.com" } })).status).toBe(403);
    expect((await app.visitor("/api/v1/public/forms/nope")).status).toBe(404);
  });
});

describe("an answer", () => {
  it("is kept, and goes to Consent, Audience, CRM, the notify list and the webhook", async () => {
    const { res, body } = await app.answer("demo", demo, { versions: { marketing: 2 } });
    expect(res.status).toBe(201);
    expect(body).toEqual({ response: { id: expect.any(String) }, thanks: "", redirect: null });
    await app.forms.flush();
    const r = app.forms.getResponse(body.response.id);
    expect(r).toMatchObject({
      status: "submitted",
      person: { email: "gizem@avci.example", name: "Gizem Avcı", company: "Avcı Lojistik" },
      hidden: { plan: "business" },
    });
    expect(r.meta).toEqual({
      url: "https://www.example.com/pricing",
      referrer: "https://www.google.com/search",
      utm: { source: "google", medium: null, campaign: "winter" },
      origin: null,
    });
    expect(r.deliveries.map((d) => [d.target, d.state])).toEqual([
      ["consent", "sent"],
      ["audience", "sent"],
      ["crm", "sent"],
      ["mail", "sent"],
      ["webhook", "sent"],
    ]);
    expect(r.deliveries[2]!.result).toEqual({ id: "deal-1", url: "https://crm.example.com/deals/deal-1" });

    const consent = app.fakes.calls("consent").find((c) => c.path === "/api/v1/consents")!;
    expect(consent.headers.authorization).toBe(`Bearer ${TOKENS.consent}`);
    expect(consent.json).toEqual({
      person: { email: "gizem@avci.example" },
      answers: [
        {
          purpose: "marketing",
          channel: "email",
          granted: true,
          version: 2,
          at: r.submittedAt,
          proof: `Demo request (forms/demo), answer ${r.id}: Offers, campaigns and news from Example by email and SMS.`,
        },
      ],
      source: "form",
      via: "forms/demo",
    });
    const audience = app.fakes.calls("audience")[0]!;
    expect(audience.json.events[0]).toEqual({
      source: "forms",
      type: "form_submitted",
      id: `forms:${r.id}`,
      at: r.submittedAt,
      person: { email: "gizem@avci.example", phone: null, userId: null, name: "Gizem Avcı" },
      traits: { region: "apac" },
      properties: { form: "demo", form_name: "Demo request", kind: "lead", page: "https://www.example.com/pricing" },
      text: "Sent the form Demo request",
    });
    const lead = app.fakes.calls("crm")[0]!.json;
    expect(lead).toMatchObject({
      external_id: `forms-${r.id}`,
      source: "forms",
      title: "Demo: Avcı Lojistik",
      name: "Gizem Avcı",
      email: "gizem@avci.example",
      company: "Avcı Lojistik",
      page: "https://www.example.com/pricing",
      utm: { source: "google", medium: null, campaign: "winter" },
      owner: { email: "apac@example.com" },
    });
    expect(lead.message).toContain("Team size: 51-200\nRegion: APAC");
    expect(lead.message).toContain("plan: business");
    expect(app.mails[0]).toMatchObject({ to: ["sales@example.com"], subject: "New answer to Demo request from Gizem Avcı", replyTo: "gizem@avci.example" });
    expect(app.mails[0]!.text).toContain(`${app.base}/responses/${r.id}`);

    // The webhook is signed as Standard Webhooks signs.
    const hook = app.fakes.calls("hook")[0]!;
    const id = hook.headers["webhook-id"] as string;
    const ts = hook.headers["webhook-timestamp"] as string;
    const sig = createHmac("sha256", Buffer.from(HOOK_SECRET.slice(6), "base64"))
      .update(`${id}.${ts}.${hook.body}`)
      .digest("base64");
    expect(hook.headers["webhook-signature"]).toBe(`v1,${sig}`);
    expect(hook.json).toMatchObject({ type: "response.submitted", data: { id: r.id, form: { id: "demo" }, answers: { size: "51-200", marketing: true } } });
  });

  it("skips a page show_if hides, and drops answers given to it", async () => {
    const { res, body } = await app.answer("demo", { name: "Kerem", email: "kerem@example.com", size: "1-10", region: "nowhere" });
    expect(res.status).toBe(201);
    const r = app.forms.getResponse(body.response.id);
    expect(r.answers!.map((a) => a.field)).toEqual(["name", "email", "size"]);
    expect(r.shownPages).toEqual([0, 2]);
  });

  it("is refused with what to change", async () => {
    const { res, body } = await app.answer("demo", { name: "", email: "x@", size: "200+" });
    expect(res.status).toBe(422);
    expect(body.code).toBe("invalid-answers");
    expect(body.errors).toEqual([
      { field: "name", code: "required", message: "This is required." },
      { field: "email", code: "email", message: "This is not an email address." },
      { field: "region", code: "required", message: "This is required." },
    ]);
  });

  it("is the same answer when sent twice with one token", async () => {
    const form = await app.load("support");
    const send = () =>
      app.visitor(
        "/api/v1/public/forms/support/responses",
        { method: "POST", body: JSON.stringify({ token: form.token, answers: { email: "a@example.com", message: "Twice is once." } }) },
        "10.9.9.9",
      );
    const a = await send();
    const b = await send();
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(((await a.json()) as any).response.id).toBe(((await b.json()) as any).response.id);
  });

  it("opens a Helpdesk ticket for a contact form", async () => {
    const { res, body } = await app.answer("support", { email: "ali@example.com", topic: "billing", message: "My invoice is wrong." });
    expect(res.status).toBe(201);
    await app.forms.flush();
    const t = app.fakes.calls("helpdesk").at(-1)!;
    expect(t.headers.authorization).toBe(`Bearer ${TOKENS.helpdesk}`);
    expect(t.json).toEqual({
      email: "ali@example.com",
      subject: "Contact: billing",
      message: "My invoice is wrong.",
      form: "billing",
      fields: { Topic: "billing" },
      language: "en",
      external_id: `forms-${body.response.id}`,
    });
    expect(app.forms.getResponse(body.response.id).deliveries).toMatchObject([
      { target: "helpdesk", state: "sent", result: { number: expect.any(Number), reference: expect.any(String) } },
    ]);
    // audience: false keeps it out of Audience.
    expect(app.fakes.calls("audience").some((c) => c.json.events[0].properties.form === "support")).toBe(false);
  });
});

describe("spam", () => {
  it("keeps a filled hidden field and a too fast answer as spam, and answers them as if taken", async () => {
    const hp = await app.answer("support", { email: "bot@example.com", message: "Buy cheap things now" }, { website: "https://spam.example" });
    expect(hp.res.status).toBe(201);
    expect(app.forms.getResponse(hp.body.response.id)).toMatchObject({ status: "spam", spamReason: "honeypot", deliveries: [] });

    const r = await app.visitor("/api/v1/public/forms/support");
    const { token } = (await r.json()) as any;
    app.clock.advance(1000);
    const fast = await app.visitor("/api/v1/public/forms/support/responses", {
      method: "POST",
      body: JSON.stringify({ token, answers: { email: "a@example.com", message: "Too fast to type" } }),
    });
    expect(fast.status).toBe(201);
    expect(app.forms.getResponse(((await fast.json()) as any).response.id)).toMatchObject({ status: "spam", spamReason: "too_fast" });
  });

  it("refuses a token another form gave, or one too old", async () => {
    const form = await app.load("demo");
    const wrong = await app.visitor("/api/v1/public/forms/support/responses", { method: "POST", body: JSON.stringify({ token: form.token, answers: {} }) });
    expect(((await wrong.json()) as any).code).toBe("invalid-token");
    app.clock.advance(3 * DAY);
    const old = await app.visitor("/api/v1/public/forms/demo/responses", { method: "POST", body: JSON.stringify({ token: form.token, answers: {} }) });
    expect(old.status).toBe(422);
    expect(((await old.json()) as any).code).toBe("expired");
  });

  it("takes a form's rate of answers from one address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await app.answer("support", { email: `p${i}@example.com`, message: "One of many answers" }, {}, "10.7.7.7")).res.status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("asks for the proof of work when the form does", async () => {
    const form = await app.load("nps");
    const bad = await app.visitor("/api/v1/public/forms/nps/responses", {
      method: "POST",
      body: JSON.stringify({ token: form.token, answers: { score: 9 }, proof: "1" }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).code).toBe("proof-of-work");
    const good = await app.answer("nps", { score: 4, why: "Slow", user_id: "u-42" });
    expect(good.res.status).toBe(201);
    expect(app.forms.getResponse(good.body.response.id)).toMatchObject({ nps: 4, hidden: { user_id: "u-42" } });
  });

  it("checks the captcha the file names", async () => {
    const other = await startApp({ settings: `${SETTINGS}\ncaptcha: { provider: turnstile, site_key: site-key }\n` });
    try {
      const f = await other.load("support");
      expect(f.spam.captcha).toEqual({ provider: "turnstile", siteKey: "site-key" });
      const page = await (await other.visitor("/f/support")).text();
      expect(page).toContain("openasy-form-support");
      const bad = await other.answer("support", { email: "a@example.com", message: "With a captcha" }, { captcha: "wrong" });
      expect(bad.body.code).toBe("captcha-failed");
      const good = await other.answer("support", { email: "a@example.com", message: "With a captcha" }, { captcha: other.fakes.state.captchaGood });
      expect(good.res.status).toBe(201);
      const csp = (await other.visitor("/f/support")).headers.get("content-security-policy")!;
      expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    } finally {
      await other.close();
    }
  });

  it("can be marked by a member, and taken out again", async () => {
    const { body } = await app.answer("support", { email: "real@example.com", message: "A real question, honest" }, { website: "x" });
    const r = await app.admin(`/api/v1/responses/${body.response.id}/not-spam`, { method: "POST" });
    expect(((await r.json()) as any).status).toBe("submitted");
    await app.forms.flush();
    expect(app.forms.getResponse(body.response.id).deliveries[0]).toMatchObject({ target: "helpdesk", state: "sent" });
    const s = await app.admin(`/api/v1/responses/${body.response.id}/spam`, { method: "POST" });
    expect((await s.json()) as any).toMatchObject({ status: "spam", spamReason: "marked by Admin token" });
  });
});

describe("files", () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 32)]);

  it("takes a file of the field's types and size, and serves it to members only, safely", async () => {
    const form = await app.load("demo");
    const up = (data: Buffer, field = "cv", token = form.token) =>
      app.visitor(`/api/v1/public/forms/demo/files?${new URLSearchParams({ token, field })}`, {
        method: "POST",
        body: data,
        headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("brief ğ.pdf") },
      });
    const html = await up(Buffer.from("<html><script>alert(1)</script></html>"));
    expect(html.status).toBe(415);
    expect(((await html.json()) as any).code).toBe("unsupported-file");
    expect((await up(Buffer.concat([pdf, Buffer.alloc(200 * 1024)]))).status).toBe(413);
    expect((await up(pdf, "name")).status).toBe(422);
    const ok = await up(pdf);
    expect(ok.status).toBe(201);
    const file = (await ok.json()) as any;
    expect(file).toEqual({ id: expect.any(String), name: "brief ğ.pdf", size: pdf.length, type: "application/pdf" });

    // The file goes only with the page view that sent it.
    const other = await app.answer("demo", { ...demo, cv: file.id });
    expect(other.body.errors).toEqual([{ field: "cv", code: "file", message: "The file is missing; attach it again." }]);
    const res = await app.visitor("/api/v1/public/forms/demo/responses", {
      method: "POST",
      body: JSON.stringify({ token: form.token, answers: { ...demo, cv: file.id } }),
    });
    expect(res.status).toBe(201);
    const r = app.forms.getResponse(((await res.json()) as any).response.id);
    expect(r.answers!.find((a) => a.field === "cv")).toMatchObject({ text: "brief ğ.pdf", file: { id: file.id, type: "application/pdf" } });

    expect((await fetch(`${app.base}/api/v1/files/${file.id}`)).status).toBe(401);
    const got = await app.admin(`/api/v1/files/${file.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''brief%20%C4%9F.pdf");
    expect(got.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("deletes a file no answer took after a day", async () => {
    const form = await app.load("demo");
    const ok = await app.visitor(`/api/v1/public/forms/demo/files?${new URLSearchParams({ token: form.token, field: "cv" })}`, { method: "POST", body: pdf });
    const { id } = (await ok.json()) as any;
    app.clock.advance(DAY + 1000);
    app.forms.sweep();
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?").get(id)).toEqual({ n: 0 });
  });
});

describe("partial answers", () => {
  const progress = (form: string, body: unknown) => app.visitor(`/api/v1/public/forms/${form}/progress`, { method: "POST", body: JSON.stringify(body) });

  it("keep how far people got, and not what they wrote, with partials: progress", async () => {
    const form = await app.load("demo");
    // Answers sent anyway are not kept.
    expect((await progress("demo", { token: form.token, page: 0, answered: ["name", "email", "nope"], answers: { name: "Secret" } })).status).toBe(204);
    expect((await progress("demo", { token: form.token, page: 1, pages: [0, 1], answered: ["name", "email", "size"] })).status).toBe(204);
    const row = app.db.prepare("SELECT * FROM responses WHERE status = 'partial' AND form = 'demo' ORDER BY started_at DESC LIMIT 1").get() as any;
    expect(row).toMatchObject({ page: 1, pages: "[0,1]", answered: '["name","email","size"]', answers: null, email: null });
    // Sending it makes the same row an answer.
    const res = await app.visitor("/api/v1/public/forms/demo/responses", { method: "POST", body: JSON.stringify({ token: form.token, answers: demo }) });
    expect(((await res.json()) as any).response.id).toBe(row.id);
  });

  it("keep the answers so far with partials: answers, never files or consent", async () => {
    const form = await app.load("support");
    await progress("support", { token: form.token, page: 0, answers: { email: "Half@Example.com", message: "short", topic: "bug" } });
    const row = app.db.prepare("SELECT * FROM responses WHERE status = 'partial' AND form = 'support'").get() as any;
    expect(JSON.parse(row.answers)).toEqual({ email: "half@example.com", topic: "bug" });
    expect(row.email).toBe("half@example.com");
  });

  it("keep nothing with partials: off", async () => {
    const form = await app.load("nps");
    expect((await progress("nps", { token: form.token, page: 0, answered: ["score"] })).status).toBe(204);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM responses WHERE status = 'partial' AND form = 'nps'").get()).toEqual({ n: 0 });
  });
});

describe("sending", () => {
  it("tries again after a failure, and stops on a refusal until someone sends it again", async () => {
    app.fakes.state.fail.crm.push(503);
    app.fakes.state.fail.audience.push(422);
    const { body } = await app.answer("demo", { ...demo, email: "retry@example.com", marketing: undefined });
    await app.forms.flush();
    let r = app.forms.getResponse(body.response.id);
    expect(r.deliveries.find((d) => d.target === "crm")).toMatchObject({
      state: "waiting",
      attempts: 1,
      error: "CRM answered 503: The fake was told to fail.",
    });
    expect(r.deliveries.find((d) => d.target === "audience")).toMatchObject({ state: "failed", error: "Audience answered 422: The fake was told to fail." });
    app.clock.advance(61_000);
    await app.forms.flush();
    r = app.forms.getResponse(body.response.id);
    expect(r.deliveries.find((d) => d.target === "crm")).toMatchObject({ state: "sent", attempts: 2 });
    const again = (await (await app.admin(`/api/v1/responses/${body.response.id}/retry`, { method: "POST" })).json()) as any;
    expect(again.deliveries.find((d: any) => d.target === "audience").state).toBe("waiting");
    await app.forms.flush();
    expect(app.forms.getResponse(body.response.id).deliveries.find((d) => d.target === "audience")!.state).toBe("sent");
  });

  it("keeps answers in Forms when a product is not linked", async () => {
    const lone = await startApp({ settings: "forms: { contact: { fields: [{ id: email, type: email, label: E }], send_to: { crm: true } } }" });
    try {
      const { body } = await lone.answer("contact", { email: "a@example.com" });
      expect(lone.forms.getResponse(body.response.id).deliveries).toEqual([]);
      const list = (await (await lone.admin("/api/v1/forms")).json()) as any;
      expect(list.forms[0].destinations).toEqual([]);
    } finally {
      await lone.close();
    }
  });
});

describe("what members see", () => {
  it("lists forms with their answers this week and where they went", async () => {
    const r = (await (await app.admin("/api/v1/forms")).json()) as any;
    const d = r.forms.find((f: any) => f.id === "demo");
    expect(d).toMatchObject({ kind: "lead", state: "open", pages: 3, languages: ["en", "tr"], url: `${app.base}/f/demo` });
    expect(d.week.submitted).toBeGreaterThan(2);
    expect(d.destinations.map((x: any) => x.target)).toEqual(["consent", "audience", "crm", "mail", "webhook"]);
    expect(r.forms.find((f: any) => f.id === "nps").nps).toMatchObject({ answers: 1, detractors: 1, score: -100 });
  });

  it("filters answers, and exports them as CSV a spreadsheet cannot run", async () => {
    await app.answer("demo", { ...demo, email: "csv@example.com", name: '=HYPERLINK("x")', size: "11-50", region: undefined });
    const all = (await (await app.admin("/api/v1/forms/demo/responses")).json()) as any;
    const some = (await (await app.admin("/api/v1/forms/demo/responses?answer.size=11-50")).json()) as any;
    expect(some.total).toBe(1);
    expect(all.total).toBeGreaterThan(some.total);
    const q = (await (await app.admin("/api/v1/forms/demo/responses?q=gizem")).json()) as any;
    expect(q.total).toBeGreaterThan(0);
    expect(q.responses.every((x: any) => x.person.name === "Gizem Avcı")).toBe(true);
    const page1 = (await (await app.admin("/api/v1/forms/demo/responses?limit=1")).json()) as any;
    const page2 = (await (await app.admin(`/api/v1/forms/demo/responses?limit=1&cursor=${page1.nextCursor}`)).json()) as any;
    expect(page2.responses[0].id).not.toBe(page1.responses[0].id);
    expect((await app.admin("/api/v1/forms/demo/responses?answer.nope=1")).status).toBe(422);

    const csv = await app.admin("/api/v1/forms/demo/export?answer.size=11-50");
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const bytes = Buffer.from(await csv.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString("utf8");
    expect(text.startsWith("Answer,Status,Sent,Started,Language,Name,Work email,Company,Team size,Region,Brief,Anything else?")).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain("crm: sent");
  });

  it("filters by the consent box and by utm_source, with the counts the filters show", async () => {
    const r = (await (await app.admin("/api/v1/forms/demo/responses?consent=yes")).json()) as any;
    expect(r.total).toBeGreaterThan(0);
    expect(r.facets.consent.yes).toBe(r.total);
    const no = (await (await app.admin("/api/v1/forms/demo/responses?consent=no")).json()) as any;
    expect(no.total).toBe(r.facets.consent.no);
    const g = (await (await app.admin("/api/v1/forms/demo/responses?source=google")).json()) as any;
    expect(g.total).toBe(r.facets.sources.find((x: any) => x.value === "google").count);
  });

  it("counts the times a form was shown", async () => {
    const before = ((await (await app.admin("/api/v1/forms")).json()) as any).forms.find((f: any) => f.id === "nps").week.views;
    await app.visitor("/f/nps");
    await app.visitor("/f/nps?preview=1");
    await app.visitor("/api/v1/public/forms/nps");
    const after = ((await (await app.admin("/api/v1/forms")).json()) as any).forms.find((f: any) => f.id === "nps").week.views;
    expect(after - before).toBe(2);
    const report = (await (await app.admin("/api/v1/forms/nps/report")).json()) as any;
    expect(report.views).toBe(after);
    expect(report.reasons).toEqual([{ response: expect.any(String), score: 4, text: "Slow", name: null, at: expect.any(String) }]);
    expect(report.npsMonths).toEqual([{ month: "2026-11", score: -100, promoters: 0, passives: 0, detractors: 1, answers: 1 }]);
  });

  it("sums up each question, where people left, and NPS by week", async () => {
    const r = (await (await app.admin("/api/v1/forms/demo/report")).json()) as any;
    expect(r.submitted).toBeGreaterThan(3);
    const size = r.questions.find((q: any) => q.field === "size");
    expect(size.options.find((o: any) => o.value === "51-200").count).toBeGreaterThan(1);
    expect(r.pages[0].reached).toBe(r.started);
    expect(r.pages[1].reached).toBeLessThan(r.pages[0].reached);
    expect(r.fields.find((f: any) => f.field === "name").answered).toBeGreaterThan(0);
    const nps = (await (await app.admin("/api/v1/forms/nps/report")).json()) as any;
    expect(nps.nps).toMatchObject({ score: -100, answers: 1 });
    expect(nps.npsWeeks).toEqual([{ week: "2026-11-02", score: -100, promoters: 0, passives: 0, detractors: 1, answers: 1 }]);
  });

  it("closes a form at its limit", async () => {
    const one = await startApp({ settings: "forms: { once: { limit: 1, fields: [{ id: email, type: email, label: E }] } }" });
    try {
      expect((await one.answer("once", { email: "a@example.com" })).res.status).toBe(201);
      const f = await one.load("once");
      expect(f.closed).toBe("full");
      const again = await one.answer("once", { email: "b@example.com" });
      expect(again.res.status).toBe(409);
    } finally {
      await one.close();
    }
  });
});

describe("the form's page", () => {
  it("has the form, a CSP that lets only the embed origins frame it, and no answer in its address logged", async () => {
    const res = await app.visitor("/f/demo?lang=tr&plan=pro");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="tr">');
    expect(html).toContain("<title>Demo isteyin</title>");
    expect(html).toContain('<script type="application/json" id="openasy-form-demo">');
    expect(html).toContain('<script src="/embed.js" async></script>');
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'self' https://www.example.com");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect((await app.visitor("/f/nope")).status).toBe(404);
    expect((await app.visitor("/embed.js")).status).toBe(503);
  });

  it("carries Analytics' script when the file names one, and escapes what could close a script", async () => {
    const other = await startApp({
      settings: 'analytics: https://analytics.example.com/s/forms.js\nforms: { x: { title: "</script><b>", fields: [{ id: a, label: A }] } }',
    });
    try {
      const res = await other.visitor("/f/x");
      const html = await res.text();
      expect(html).toContain('<script defer src="https://analytics.example.com/s/forms.js"></script>');
      expect(html).not.toContain("</script><b>");
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' https://analytics.example.com");
      expect(await (await other.visitor("/f/x?preview=1")).text()).not.toContain("analytics.example.com/s/forms.js");
    } finally {
      await other.close();
    }
  });
});

describe("Audience: POST /api/v1/erasures", () => {
  it("deletes every answer of the person, once per reference", async () => {
    await app.answer("support", { email: "erase@example.com", message: "Please forget me later" });
    const before = app.db.prepare("SELECT COUNT(*) AS n FROM responses WHERE email = 'erase@example.com' OR user_id = 'u-42'").get() as { n: number };
    expect(before.n).toBe(2);
    const body = { reference: "KVKK-2026-031", product: "audience", people: { emails: ["Erase@Example.com"], phones: [], userIds: ["u-42"] } };
    const r = await app.admin("/api/v1/erasures", { method: "POST", body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "done", deleted: 2 });
    const again = await app.admin("/api/v1/erasures", { method: "POST", body: JSON.stringify(body) });
    expect(await again.json()).toEqual({ status: "done", deleted: 2 });
    expect((await fetch(`${app.base}/api/v1/erasures`, { method: "POST", body: JSON.stringify(body) })).status).toBe(401);
  });
});
