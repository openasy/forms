// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicField, PublicForm } from "../server/logic.ts";
import { workDone } from "../server/spam.ts";
import { mount, start, work } from "./f.ts";

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

const FORM: PublicForm = {
  id: "demo",
  name: "Demo request",
  kind: "lead",
  language: "en",
  title: "Book a demo",
  description: null,
  hidden: ["plan"],
  pages: [
    {
      title: "About you",
      description: null,
      showIf: [],
      fields: [
        field({ id: "email", type: "email", label: "Work email", required: true }),
        field({ id: "size", type: "choice", label: "Team size", required: true, options: ["1-10", "51-200"].map((v) => ({ value: v, label: v })) }),
      ],
    },
    { title: "Your team", description: null, showIf: [{ field: "size", is: "51-200" }], fields: [field({ id: "region", label: "Region", required: true })] },
    {
      title: null,
      description: null,
      showIf: [],
      fields: [
        field({ id: "score", type: "nps", label: "Recommend us?" }),
        field({ id: "marketing", type: "consent", label: "Offers by email.", consent: { purpose: "marketing", channels: ["email"], version: 2 } }),
      ],
    },
  ],
  submit: "",
  thanks: "Thanks!",
  redirect: null,
  closed: null,
  closedText: null,
  token: "abc.def.ghi",
  spam: { honeypot: "website", proofOfWork: null, captcha: null },
  partials: "progress",
  endpoint: "https://forms.example.com",
};

let sent: Array<{ url: string; body: any }>;
let answer: { status: number; body: unknown };
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

/** Submit events as OpenAsy Analytics' script sees them: on window, in the capture phase. */
let submits: string[];
const onSubmit = (e: Event) => submits.push((e.target as HTMLFormElement).id);

beforeEach(() => {
  sent = [];
  submits = [];
  answer = { status: 201, body: { response: { id: "r1" }, thanks: "Thanks!", redirect: null } };
  document.body.innerHTML = '<div id="root"></div>';
  sessionStorage.clear();
  window.addEventListener("submit", onSubmit, { capture: true });
});
afterEach(() => window.removeEventListener("submit", onSubmit, { capture: true }));

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const type = (sel: string, v: string) => {
  const i = $<HTMLInputElement>(sel);
  i.value = v;
  i.dispatchEvent(new Event("input", { bubbles: true }));
};
const tick = (sel: string) => {
  const i = $<HTMLInputElement>(sel);
  i.checked = true;
  i.dispatchEvent(new Event("change", { bubbles: true }));
};
const click = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent === text && !b.closest(".oaf-hidden") && !b.classList.contains("oaf-hidden"))!
    .click();
const flush = () => new Promise((r) => setTimeout(r, 0));
const visiblePage = () => [...document.querySelectorAll(".oaf-page")].findIndex((p) => !p.classList.contains("oaf-hidden"));

describe("the form script", () => {
  it("draws a real form Analytics can see, with a field people never see", () => {
    mount($("#root"), FORM, { endpoint: FORM.endpoint, fetch: fakeFetch });
    const form = $<HTMLFormElement>("form.oaf");
    expect(form.id).toBe("oaf-demo");
    expect($<HTMLInputElement>('input[name="email"]').type).toBe("email");
    expect($<HTMLInputElement>('input[name="email"]').autocomplete).toBe("email");
    const hp = $<HTMLInputElement>('input[name="website"]');
    expect(hp.tabIndex).toBe(-1);
    expect(hp.closest(".oaf-hp")).not.toBeNull();
    expect($("label[for='oaf-demo-email']").textContent).toBe("Work email*");
  });

  it("checks a page on Next, follows show_if, and goes Back", async () => {
    mount($("#root"), FORM, { endpoint: FORM.endpoint, fetch: fakeFetch });
    click("Next");
    expect($("#oaf-demo-email-error").textContent).toBe("Please answer this.");
    expect($("#oaf-demo-email").getAttribute("aria-invalid")).toBe("true");
    expect($('[role="status"]').textContent).toBe("Some answers need a change.");
    type("#oaf-demo-email", "ada@example.com");
    tick("#oaf-demo-size-0");
    click("Next");
    // 1-10 skips the team page.
    expect(visiblePage()).toBe(2);
    expect($(".oaf-steps").textContent).toBe("Step 2 of 2");
    click("Back");
    tick("#oaf-demo-size-1");
    click("Next");
    expect(visiblePage()).toBe(1);
    expect($(".oaf-steps").textContent).toBe("Step 2 of 3");
    // Next is never a submit: Analytics counts only the answer sent.
    expect(submits).toEqual([]);
    await flush();
    // How far it got, without what was written.
    const progress = sent.filter((s) => s.url.endsWith("/progress"));
    expect(progress.at(-1)!.body).toEqual({ token: "abc.def.ghi", page: 1, language: "en", answered: ["email", "size"], pages: [0, 1] });
  });

  it("sends the answer once, with a submit event, and thanks", async () => {
    const track = vi.fn();
    (window as any).openasy = { track };
    history.replaceState(null, "", "/pricing?plan=pro&email=from-the-link@example.com&utm_source=google");
    mount($("#root"), FORM, { endpoint: FORM.endpoint, fetch: fakeFetch, values: { plan: "pro", email: "from-the-link@example.com" } });
    expect($<HTMLInputElement>("#oaf-demo-email").value).toBe("from-the-link@example.com");
    tick("#oaf-demo-size-0");
    click("Next");
    tick("#oaf-demo-score-9");
    tick("#oaf-demo-marketing");
    click("Send");
    await flush();
    await flush();
    expect(submits).toEqual(["oaf-demo"]);
    const post = sent.find((s) => s.url === "https://forms.example.com/api/v1/public/forms/demo/responses")!;
    expect(post.body).toEqual({
      token: "abc.def.ghi",
      answers: { plan: "pro", email: "from-the-link@example.com", size: "1-10", score: 9, marketing: true },
      language: "en",
      page: { url: "http://localhost:3000/pricing?plan=pro&email=from-the-link@example.com&utm_source=google", referrer: "" },
      website: "",
      versions: { marketing: 2 },
    });
    expect($(".oaf-done").textContent).toBe("Thanks!");
    // Analytics gets the form's id and nothing typed.
    expect(track.mock.calls).toEqual([
      ["form_view", { form: "demo" }],
      ["form_submit", { form: "demo" }],
    ]);
    delete (window as any).openasy;
    history.replaceState(null, "", "/");
  });

  it("shows the server's answer when it refuses", async () => {
    answer = { status: 422, body: { code: "invalid-answers", errors: [{ field: "email", code: "email", message: "x" }] } };
    mount($("#root"), { ...FORM, pages: [FORM.pages[0]!] }, { endpoint: FORM.endpoint, fetch: fakeFetch });
    type("#oaf-demo-email", "ada@example.com");
    tick("#oaf-demo-size-0");
    click("Send");
    await flush();
    await flush();
    expect($("#oaf-demo-email-error").textContent).toBe("Enter an email address, such as name@example.com.");
    answer = { status: 429, body: { code: "rate-limited" } };
    click("Send");
    await flush();
    await flush();
    expect($('[role="status"]').textContent).toBe("Too many answers from here. Wait a minute and try again.");
  });

  it("speaks Turkish and German, and says when a form is closed", () => {
    mount($("#root"), { ...FORM, language: "tr", closed: "full" }, { endpoint: FORM.endpoint, fetch: fakeFetch });
    expect($(".oaf-done").textContent).toBe("Bu form gereken tüm yanıtları aldı.");
    mount($("#root"), { ...FORM, language: "de" }, { endpoint: FORM.endpoint, fetch: fakeFetch });
    expect(click("Weiter")).toBeUndefined();
    expect($("#oaf-demo-email-error").textContent).toBe("Bitte beantworten Sie dies.");
  });

  it("does nothing a preview should not", async () => {
    mount($("#root"), { ...FORM, pages: [FORM.pages[0]!] }, { endpoint: FORM.endpoint, fetch: fakeFetch, preview: true });
    type("#oaf-demo-email", "ada@example.com");
    tick("#oaf-demo-size-0");
    click("Send");
    await flush();
    expect(sent).toEqual([]);
    expect(document.body.textContent).toContain("Preview: the answer was not sent.");
  });

  it("draws the forms of a page from the tag, with the JSON the form's own page carries", async () => {
    document.body.innerHTML = `<p>Intro</p><script id="tag" src="https://forms.example.com/embed.js" data-form="demo" data-value-plan="business"></script>
      <script type="application/json" id="openasy-form-demo">${JSON.stringify(FORM)}</script>`;
    start($<HTMLScriptElement>("#tag"));
    await flush();
    const box = $("[data-openasy-form='demo']");
    expect(box.previousElementSibling?.id).toBe("tag");
    expect(box.querySelector("form.oaf")).not.toBeNull();
  });

  it("hides fields the link fills when it says so", () => {
    mount($("#root"), FORM, { endpoint: FORM.endpoint, fetch: fakeFetch, values: { email: "ada@example.com" }, hide: ["email", "size"] });
    expect($("#oaf-demo-email").closest(".oaf-field")!.classList.contains("oaf-hidden")).toBe(true);
    // size was not given, so it is shown.
    expect($("#oaf-demo-size-0").closest(".oaf-field")!.classList.contains("oaf-hidden")).toBe(false);
  });

  it("opens the form in a dialog from a button with data-mode=popup", async () => {
    document.body.innerHTML = `<div data-openasy-form="demo" data-mode="popup" data-button="Ask for a demo"></div>
      <script type="application/json" id="openasy-form-demo">${JSON.stringify(FORM)}</script>`;
    start(null);
    expect(document.querySelector("form.oaf")).toBeNull();
    click("Ask for a demo");
    await flush();
    expect($("dialog.oaf-popup form.oaf")).not.toBeNull();
  });

  it("finds the proof of work the server checks", async () => {
    const nonce = await work("1a2b.nonce.sig", 10);
    expect(workDone("1a2b.nonce.sig", nonce, 10)).toBe(true);
  });
});
