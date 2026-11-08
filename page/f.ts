// The form script, /embed.js: it draws a form on the form's own page and on any site the form's embed list names,
// from one tag:
//
//   <script src="https://forms.example.com/embed.js" data-form="demo" async></script>
//
// The form is drawn right after the tag, or in every <div data-openasy-form="demo"></div> of the page. It is a plain
// <form> in the page itself (no frame), so the page's own styles and OpenAsy Analytics see it: Analytics counts the
// form started and sent, and never reads a value. Pages are shown one at a time with Next and Back; show_if is
// applied as people answer, with the same rules the server checks again. Hidden fields and any answer can be filled
// from the page's address (?plan=pro) or the tag's data-value-<field> attributes.
//
// What it sends: how far people got (as the form's partials setting says), files as they are chosen, and the answer.
// Spam filters: a field people never see, the token the form came with, and, when the form asks, a proof of work found
// while people type, or the captcha the settings file names.
import {
  check,
  display,
  shown,
  validate,
  type Answers,
  type ErrorCode,
  type FieldError,
  type PublicField,
  type PublicForm,
  type Value,
} from "../server/logic.ts";
import { sha256 } from "./sha256.ts";

type Lang = "en" | "tr" | "de";
type Words = Record<
  | ErrorCode
  | "next"
  | "back"
  | "send"
  | "sending"
  | "step"
  | "choose"
  | "attach"
  | "remove"
  | "uploading"
  | "fileTooLarge"
  | "fileType"
  | "uploadFailed"
  | "thanks"
  | "closed"
  | "full"
  | "network"
  | "expired"
  | "wait"
  | "notLikely"
  | "veryLikely"
  | "yes"
  | "no"
  | "checking"
  | "captcha"
  | "fix"
  | "preview"
  | "loadFailed",
  string
>;

export const WORDS: Record<Lang, Words> = {
  en: {
    required: "Please answer this.",
    too_short: "This is too short.",
    too_long: "This is too long.",
    too_small: "This number is too small.",
    too_large: "This number is too large.",
    pattern: "This is not in the form asked for.",
    email: "Enter an email address, such as name@example.com.",
    phone: "Enter a phone number.",
    url: "Enter a web address, such as https://example.com.",
    date: "Enter a day.",
    number: "Enter a number.",
    option: "Choose one of the options.",
    too_few: "Tick more of these.",
    too_many: "Tick fewer of these.",
    file: "Attach the file again.",
    next: "Next",
    back: "Back",
    send: "Send",
    sending: "Sending…",
    step: "Step {n} of {m}",
    choose: "Choose…",
    attach: "Attach a file",
    remove: "Remove",
    uploading: "Uploading…",
    fileTooLarge: "The file is larger than {size}.",
    fileType: "This type of file is not taken here.",
    uploadFailed: "The file could not be sent; try again.",
    thanks: "Thank you. Your answer has been sent.",
    closed: "This form is closed.",
    full: "This form has all the answers it needs.",
    network: "The answer could not be sent. Check your connection and try again.",
    expired: "This page was open too long. Load it again to send your answer.",
    wait: "Too many answers from here. Wait a minute and try again.",
    notLikely: "Not likely",
    veryLikely: "Very likely",
    yes: "Yes",
    no: "No",
    checking: "Checking that this is not a bot…",
    captcha: "Solve the check above, then send again.",
    fix: "Some answers need a change.",
    preview: "Preview: the answer was not sent.",
    loadFailed: "The form could not be loaded.",
  },
  tr: {
    required: "Lütfen bunu yanıtlayın.",
    too_short: "Bu çok kısa.",
    too_long: "Bu çok uzun.",
    too_small: "Bu sayı çok küçük.",
    too_large: "Bu sayı çok büyük.",
    pattern: "Bu istenen biçimde değil.",
    email: "Bir e-posta adresi yazın, örneğin ad@ornek.com.",
    phone: "Bir telefon numarası yazın.",
    url: "Bir web adresi yazın, örneğin https://ornek.com.",
    date: "Bir gün girin.",
    number: "Bir sayı girin.",
    option: "Seçeneklerden birini seçin.",
    too_few: "Bunlardan daha fazlasını işaretleyin.",
    too_many: "Bunlardan daha azını işaretleyin.",
    file: "Dosyayı yeniden ekleyin.",
    next: "İleri",
    back: "Geri",
    send: "Gönder",
    sending: "Gönderiliyor…",
    step: "Adım {n} / {m}",
    choose: "Seçin…",
    attach: "Dosya ekleyin",
    remove: "Kaldır",
    uploading: "Yükleniyor…",
    fileTooLarge: "Dosya {size} boyutundan büyük.",
    fileType: "Bu dosya türü burada alınmıyor.",
    uploadFailed: "Dosya gönderilemedi; yeniden deneyin.",
    thanks: "Teşekkürler. Yanıtınız gönderildi.",
    closed: "Bu form kapandı.",
    full: "Bu form gereken tüm yanıtları aldı.",
    network: "Yanıt gönderilemedi. Bağlantınızı kontrol edip yeniden deneyin.",
    expired: "Bu sayfa çok uzun süre açık kaldı. Yanıtınızı göndermek için yeniden yükleyin.",
    wait: "Buradan çok fazla yanıt geldi. Bir dakika bekleyip yeniden deneyin.",
    notLikely: "Hiç olası değil",
    veryLikely: "Çok olası",
    yes: "Evet",
    no: "Hayır",
    checking: "Bunun bir bot olmadığı kontrol ediliyor…",
    captcha: "Yukarıdaki doğrulamayı tamamlayıp yeniden gönderin.",
    fix: "Bazı yanıtların değişmesi gerekiyor.",
    preview: "Önizleme: yanıt gönderilmedi.",
    loadFailed: "Form yüklenemedi.",
  },
  de: {
    required: "Bitte beantworten Sie dies.",
    too_short: "Das ist zu kurz.",
    too_long: "Das ist zu lang.",
    too_small: "Diese Zahl ist zu klein.",
    too_large: "Diese Zahl ist zu groß.",
    pattern: "Das hat nicht die verlangte Form.",
    email: "Geben Sie eine E-Mail-Adresse ein, etwa name@example.com.",
    phone: "Geben Sie eine Telefonnummer ein.",
    url: "Geben Sie eine Webadresse ein, etwa https://example.com.",
    date: "Geben Sie einen Tag ein.",
    number: "Geben Sie eine Zahl ein.",
    option: "Wählen Sie eine der Optionen.",
    too_few: "Kreuzen Sie mehr davon an.",
    too_many: "Kreuzen Sie weniger davon an.",
    file: "Hängen Sie die Datei erneut an.",
    next: "Weiter",
    back: "Zurück",
    send: "Senden",
    sending: "Wird gesendet…",
    step: "Schritt {n} von {m}",
    choose: "Auswählen…",
    attach: "Datei anhängen",
    remove: "Entfernen",
    uploading: "Wird hochgeladen…",
    fileTooLarge: "Die Datei ist größer als {size}.",
    fileType: "Diese Dateiart wird hier nicht angenommen.",
    uploadFailed: "Die Datei konnte nicht gesendet werden; versuchen Sie es erneut.",
    thanks: "Danke. Ihre Antwort wurde gesendet.",
    closed: "Dieses Formular ist geschlossen.",
    full: "Dieses Formular hat alle Antworten, die es braucht.",
    network: "Die Antwort konnte nicht gesendet werden. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
    expired: "Diese Seite war zu lange offen. Laden Sie sie neu, um Ihre Antwort zu senden.",
    wait: "Zu viele Antworten von hier. Warten Sie eine Minute und versuchen Sie es erneut.",
    notLikely: "Unwahrscheinlich",
    veryLikely: "Sehr wahrscheinlich",
    yes: "Ja",
    no: "Nein",
    checking: "Es wird geprüft, dass dies kein Bot ist…",
    captcha: "Lösen Sie die Prüfung oben und senden Sie erneut.",
    fix: "Einige Antworten müssen geändert werden.",
    preview: "Vorschau: Die Antwort wurde nicht gesendet.",
    loadFailed: "Das Formular konnte nicht geladen werden.",
  },
};

const STYLE = `.oaf{font:inherit;color:inherit;max-width:640px;text-align:left}
.oaf *{box-sizing:border-box}
.oaf-title{font-size:1.5em;line-height:1.25;margin:0 0 .4em}
.oaf-desc,.oaf-page-desc{margin:0 0 1.2em;opacity:.85;white-space:pre-line}
.oaf-page-title{font-size:1.15em;margin:0 0 .6em}
.oaf-steps{font-size:.85em;opacity:.75;margin:0 0 .4em}
.oaf-bar{height:4px;border-radius:2px;background:color-mix(in srgb,currentColor 12%,transparent);margin:0 0 1.4em;overflow:hidden}
.oaf-bar>span{display:block;height:100%;background:var(--oaf-accent,#2f5bd3);transition:width .2s}
.oaf-field{margin:0 0 1.25em;padding:0;border:0;min-width:0}
.oaf-label,.oaf-field>legend{display:block;font-weight:600;margin:0 0 .4em;padding:0}
.oaf-req{color:#c62828;margin-left:.15em}
.oaf-help{display:block;font-size:.875em;opacity:.75;margin:-.2em 0 .5em}
.oaf-input{display:block;width:100%;padding:.6em .75em;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:8px;background:transparent;color:inherit;font:inherit}
textarea.oaf-input{min-height:7em;resize:vertical}
select.oaf-input{background:transparent}
select.oaf-input option{color:#16181d;background:#fff}
.oaf-input:focus-visible,.oaf-opt:focus-within,.oaf-btn:focus-visible{outline:2px solid var(--oaf-accent,#2f5bd3);outline-offset:1px}
.oaf-input[aria-invalid=true]{border-color:#c62828}
.oaf-opt{display:flex;gap:.6em;align-items:flex-start;padding:.55em .75em;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;margin:0 0 .4em;cursor:pointer}
.oaf-opt:has(input:checked){border-color:var(--oaf-accent,#2f5bd3);background:color-mix(in srgb,var(--oaf-accent,#2f5bd3) 10%,transparent)}
.oaf-opt input{margin:.25em 0 0;accent-color:var(--oaf-accent,#2f5bd3)}
.oaf-consent{white-space:pre-line}
.oaf-scale{display:flex;gap:.35em;flex-wrap:wrap}
.oaf-scale .oaf-opt{flex:1 0 2.4em;justify-content:center;margin:0;padding:.5em .2em;text-align:center}
.oaf-scale .oaf-opt input{position:absolute;opacity:0;width:1px;height:1px}
.oaf-scale .oaf-opt:has(input:checked){background:var(--oaf-accent,#2f5bd3);color:#fff}
.oaf-stars .oaf-opt{flex:0 0 auto;font-size:1.4em;line-height:1;padding:.25em .4em}
.oaf-ends{display:flex;justify-content:space-between;font-size:.8em;opacity:.75;margin-top:.35em}
.oaf-error{color:#c62828;font-size:.875em;margin:.35em 0 0}
.oaf-file{display:flex;gap:.6em;align-items:center;flex-wrap:wrap}
.oaf-actions{display:flex;gap:.6em;justify-content:space-between;margin-top:1.5em;flex-wrap:wrap}
.oaf-btn{font:inherit;font-weight:600;border-radius:8px;padding:.65em 1.25em;cursor:pointer;border:1px solid var(--oaf-accent,#2f5bd3);background:var(--oaf-accent,#2f5bd3);color:#fff}
.oaf-btn[disabled]{opacity:.6;cursor:progress}
.oaf-btn.oaf-ghost{background:transparent;color:inherit;border-color:color-mix(in srgb,currentColor 28%,transparent)}
.oaf-btn.oaf-small{padding:.3em .7em;font-weight:500;font-size:.875em}
.oaf-status{margin:1em 0 0}
.oaf-status:empty{display:none}
.oaf-alert{padding:.7em .9em;border-radius:8px;background:color-mix(in srgb,#c62828 12%,transparent)}
.oaf-done{padding:.5em 0;white-space:pre-line}
.oaf-hp{position:absolute!important;left:-10000px!important;top:auto;width:1px;height:1px;overflow:hidden}
.oaf-hidden{display:none}`;

interface Options {
  endpoint: string;
  lang?: string;
  preview?: boolean;
  /** Answers given by the page: its address's query and the tag's data-value-<field> attributes. */
  values?: Record<string, string>;
  /** Fields not shown when they were given a value (?hide=email). */
  hide?: string[];
  /** The page's address and referrer, for utm_* and where the answer came from. */
  page?: { url: string; referrer: string };
  fetch?: typeof fetch;
}

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...kids: Array<Node | string | null | false>
) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k) el.append(k);
  return el;
};

/** Leading zero bits of a hash. */
function zeros(b: Uint8Array): number {
  let n = 0;
  for (const x of b) {
    if (x === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(x) - 24;
  }
  return n;
}

/** Finds a number whose hash with the token starts with `bits` zero bits, a slice at a time so the page stays responsive. */
export function work(token: string, bits: number): Promise<string> {
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      const end = i + 4000;
      for (; i < end; i++) if (zeros(sha256(`${token}:${i}`)) >= bits) return resolve(String(i));
      setTimeout(step, 0);
    };
    step();
  });
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10} MB` : `${Math.round(n / 1024)} KB`);

/** Draws one form in `root` and runs it. */
export function mount(root: HTMLElement, form: PublicForm, o: Options) {
  const lang = (["en", "tr", "de"].includes(form.language) ? form.language : "en") as Lang;
  const w = WORDS[lang];
  const f = o.fetch ?? fetch.bind(window);
  const api = `${o.endpoint}/api/v1/public/forms/${form.id}`;
  const store = `openasy-form:${form.id}`;
  const answers: Answers = {};
  const fileNames: Record<string, { name: string; size: number }> = {};
  const versions: Record<string, number> = {};
  let errors: Record<string, ErrorCode | string> = {};
  let page = 0;
  let trail: number[] = [];
  let started = false;
  let captchaToken: string | null = null;
  let proof: Promise<string> | null = null;

  for (const p of form.pages) for (const x of p.fields) if (x.consent?.version) versions[x.id] = x.consent.version;
  const tracker = () => (window as unknown as { openasy?: { track?: (n: string, p: Record<string, string>) => void } }).openasy;

  // What the page gave, then what this browser kept of an answer not sent yet.
  const fieldOf = (id: string) => form.pages.flatMap((p) => p.fields).find((x) => x.id === id);
  for (const [k, v] of Object.entries(o.values ?? {})) {
    const fd = fieldOf(k);
    if (form.hidden.includes(k)) answers[k] = v.slice(0, 500);
    else if (fd && !["file", "consent", "statement"].includes(fd.type)) answers[k] = fd.type === "choices" ? v.split(",") : v;
  }
  try {
    const kept = JSON.parse(sessionStorage.getItem(store) ?? "null") as { answers: Answers; trail: number[]; page: number } | null;
    if (kept && !o.preview) {
      for (const [k, v] of Object.entries(kept.answers)) if (fieldOf(k) && fieldOf(k)!.type !== "file" && answers[k] === undefined) answers[k] = v;
      if (typeof kept.page === "number" && kept.page < form.pages.length) ((page = kept.page), (trail = kept.trail ?? []));
    }
  } catch {
    // Storage may be blocked; the form works without it.
  }
  const keep = () => {
    try {
      sessionStorage.setItem(
        store,
        JSON.stringify({ answers: Object.fromEntries(Object.entries(answers).filter(([k]) => fieldOf(k)?.type !== "file")), trail, page }),
      );
    } catch {
      // Storage may be blocked or full.
    }
  };

  if (!document.getElementById("oaf-style")) document.head.append(h("style", { id: "oaf-style", text: STYLE }));
  root.innerHTML = "";
  const el = h("form", { class: "oaf", id: `oaf-${form.id}`, novalidate: true, "aria-labelledby": `oaf-${form.id}-title` });
  root.append(el);

  const status = h("div", { class: "oaf-status", role: "status", "aria-live": "polite" });
  const say = (text: string, alert = false) => {
    status.textContent = text;
    status.className = `oaf-status${alert && text ? " oaf-alert" : ""}`;
  };

  if (form.closed) {
    el.append(
      h("h2", { class: "oaf-title", id: `oaf-${form.id}-title`, text: form.title }),
      h("p", { class: "oaf-done", text: form.closedText || w[form.closed] }),
    );
    return { el };
  }

  // A field people never see; a bot that fills every field fills it too.
  const honeypot = h("input", { type: "text", name: form.spam.honeypot, tabindex: "-1", autocomplete: "off", "aria-hidden": "true" }) as HTMLInputElement;
  const pageEls: HTMLElement[] = [];
  const fieldEls = new Map<string, { wrap: HTMLElement; error: HTMLElement; focus: () => void }>();
  const bar = h("span");
  const steps = h("p", { class: "oaf-steps" });
  const back = h("button", { type: "button", class: "oaf-btn oaf-ghost", text: w.back }) as HTMLButtonElement;
  const next = h("button", { type: "button", class: "oaf-btn", text: w.next }) as HTMLButtonElement;
  const sendBtn = h("button", { type: "button", class: "oaf-btn", text: form.submit || w.send }) as HTMLButtonElement;
  const captchaBox = h("div", { class: "oaf-captcha" });

  const set = (id: string, v: Value | undefined) => {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete answers[id];
    else answers[id] = v;
    if (errors[id]) {
      delete errors[id];
      showErrors();
    }
    if (!started) {
      started = true;
      void save();
    }
    keep();
    refresh();
  };

  const uid = (id: string, suffix = "") => `oaf-${form.id}-${id}${suffix}`;

  function input(fd: PublicField): { node: Node; focus: () => void } {
    const id = uid(fd.id);
    const described = `${fd.help ? `${id}-help ` : ""}${id}-error`;
    const common = { id, name: fd.id, "aria-describedby": described, required: fd.required, class: "oaf-input" };
    const current = answers[fd.id];
    switch (fd.type) {
      case "textarea": {
        const t = h("textarea", { ...common, placeholder: fd.placeholder ?? undefined, maxlength: String(fd.max ?? 5000) }) as HTMLTextAreaElement;
        t.value = typeof current === "string" ? current : "";
        t.addEventListener("input", () => set(fd.id, t.value));
        return { node: t, focus: () => t.focus() };
      }
      case "select": {
        const s = h("select", common, h("option", { value: "", text: w.choose })) as HTMLSelectElement;
        for (const op of fd.options) s.append(h("option", { value: op.value, text: op.label }));
        s.value = typeof current === "string" ? current : "";
        s.addEventListener("change", () => set(fd.id, s.value));
        return { node: s, focus: () => s.focus() };
      }
      case "choice":
      case "choices":
      case "yes_no":
      case "rating":
      case "scale":
      case "nps": {
        const multi = fd.type === "choices";
        const options =
          fd.type === "yes_no"
            ? [
                { value: "yes", label: w.yes },
                { value: "no", label: w.no },
              ]
            : fd.type === "rating"
              ? Array.from({ length: fd.max ?? 5 }, (_, i) => ({ value: String(i + 1), label: "★" }))
              : fd.type === "scale" || fd.type === "nps"
                ? Array.from({ length: (fd.type === "nps" ? 10 : fd.max!) - (fd.type === "nps" ? 0 : fd.min!) + 1 }, (_, i) => {
                    const n = String((fd.type === "nps" ? 0 : fd.min!) + i);
                    return { value: n, label: n };
                  })
                : fd.options;
        const group = h("div", {
          class: fd.type === "rating" ? "oaf-scale oaf-stars" : fd.type === "scale" || fd.type === "nps" ? "oaf-scale" : "oaf-options",
          role: multi ? "group" : "radiogroup",
        });
        const boxes: HTMLInputElement[] = [];
        const chosen = (v: string) =>
          Array.isArray(current) ? current.includes(v) : current !== undefined && String(current === true ? "yes" : current === false ? "no" : current) === v;
        options.forEach((op, i) => {
          const box = h("input", {
            type: multi ? "checkbox" : "radio",
            name: fd.id,
            value: op.value,
            id: `${id}-${i}`,
            "aria-describedby": described,
          }) as HTMLInputElement;
          box.checked = chosen(op.value);
          boxes.push(box);
          const aria = fd.type === "rating" ? `${op.value} / ${fd.max ?? 5}` : undefined;
          group.append(h("label", { class: "oaf-opt", for: `${id}-${i}`, ...(aria && { "aria-label": aria }) }, box, h("span", { text: op.label })));
          box.addEventListener("change", () => {
            if (multi)
              set(
                fd.id,
                boxes.filter((b) => b.checked).map((b) => b.value),
              );
            else set(fd.id, ["rating", "scale", "nps"].includes(fd.type) ? Number(box.value) : box.value);
            if (fd.type === "rating") paintStars();
          });
        });
        const paintStars = () => {
          const v = Number(answers[fd.id] ?? 0);
          boxes.forEach((b, i) => (b.parentElement!.style.opacity = i < v ? "1" : "0.35"));
        };
        if (fd.type === "rating") paintStars();
        const wrap = h("div", {}, group);
        const lo = fd.minLabel ?? (fd.type === "nps" ? w.notLikely : null);
        const hi = fd.maxLabel ?? (fd.type === "nps" ? w.veryLikely : null);
        if ((fd.type === "scale" || fd.type === "nps") && (lo || hi))
          wrap.append(h("div", { class: "oaf-ends", "aria-hidden": "true" }, h("span", { text: lo ?? "" }), h("span", { text: hi ?? "" })));
        return { node: wrap, focus: () => (boxes.find((b) => b.checked) ?? boxes[0])?.focus() };
      }
      case "consent": {
        const box = h("input", { type: "checkbox", name: fd.id, id, "aria-describedby": described, value: "yes" }) as HTMLInputElement;
        box.checked = current === true;
        box.addEventListener("change", () => set(fd.id, box.checked ? true : undefined));
        const label = h(
          "label",
          { class: "oaf-opt", for: id },
          box,
          h("span", { class: "oaf-consent" }, fd.label, fd.required ? h("span", { class: "oaf-req", "aria-hidden": "true", text: "*" }) : null),
        );
        return { node: label, focus: () => box.focus() };
      }
      case "file": {
        const pick = h("input", { type: "file", id, name: fd.id, accept: fd.accept.join(","), "aria-describedby": described }) as HTMLInputElement;
        const wrap = h("div", { class: "oaf-file" });
        const draw = () => {
          wrap.innerHTML = "";
          const has = typeof answers[fd.id] === "string" && fileNames[fd.id];
          if (has) {
            const rm = h("button", { type: "button", class: "oaf-btn oaf-ghost oaf-small", text: w.remove }) as HTMLButtonElement;
            rm.addEventListener("click", () => {
              delete fileNames[fd.id];
              set(fd.id, undefined);
              draw();
            });
            wrap.append(h("span", { text: `${fileNames[fd.id]!.name} (${fmtSize(fileNames[fd.id]!.size)})` }), rm);
          } else wrap.append(pick);
        };
        pick.addEventListener("change", () => {
          const file = pick.files?.[0];
          if (!file) return;
          if (fd.maxSize && file.size > fd.maxSize) return fail(w.fileTooLarge.replace("{size}", fmtSize(fd.maxSize)));
          if (o.preview) {
            fileNames[fd.id] = { name: file.name, size: file.size };
            set(fd.id, "preview-file-0000000");
            return draw();
          }
          say(w.uploading);
          const p = new URLSearchParams({ token: form.token, field: fd.id });
          void f(`${api}/files?${p}`, {
            method: "POST",
            body: file,
            headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
          })
            .then(async (res) => {
              const b = (await res.json().catch(() => null)) as { id?: string; code?: string } | null;
              if (!res.ok || !b?.id)
                return fail(
                  b?.code === "unsupported-file"
                    ? w.fileType
                    : b?.code === "payload-too-large"
                      ? w.fileTooLarge.replace("{size}", fmtSize(fd.maxSize ?? 0))
                      : w.uploadFailed,
                );
              say("");
              fileNames[fd.id] = { name: file.name, size: file.size };
              set(fd.id, b.id);
              draw();
            })
            .catch(() => fail(w.uploadFailed));
          function fail(msg: string) {
            say("");
            pick.value = "";
            errors[fd.id] = msg;
            showErrors();
          }
        });
        draw();
        return { node: wrap, focus: () => (wrap.querySelector("input,button") as HTMLElement | null)?.focus() };
      }
      case "statement":
        return { node: h("p", { class: "oaf-desc", text: fd.label }), focus: () => {} };
      default: {
        const type = { email: "email", phone: "tel", url: "url", number: "text", date: "date" }[fd.type as string] ?? "text";
        const auto =
          fd.type === "email"
            ? "email"
            : fd.type === "phone"
              ? "tel"
              : fd.id === "name" || fd.id === "full_name"
                ? "name"
                : fd.id === "company"
                  ? "organization"
                  : undefined;
        const i = h("input", {
          ...common,
          type,
          placeholder: fd.placeholder ?? undefined,
          autocomplete: auto,
          inputmode: fd.type === "number" ? "decimal" : undefined,
          maxlength: fd.type === "number" || fd.type === "date" ? undefined : String(fd.max ?? 300),
        }) as HTMLInputElement;
        i.value = current === undefined ? "" : String(current);
        i.addEventListener("input", () => set(fd.id, i.value));
        return { node: i, focus: () => i.focus() };
      }
    }
  }

  // The form: its title, the pages, and the buttons.
  el.append(h("h2", { class: "oaf-title", id: `oaf-${form.id}-title`, text: form.title }));
  if (form.description) el.append(h("p", { class: "oaf-desc", text: form.description }));
  if (form.pages.length > 1) el.append(steps, h("div", { class: "oaf-bar", "aria-hidden": "true" }, bar));
  form.pages.forEach((p) => {
    const sec = h("section", { class: "oaf-page" });
    if (p.title) sec.append(h("h3", { class: "oaf-page-title", text: p.title }));
    if (p.description) sec.append(h("p", { class: "oaf-page-desc", text: p.description }));
    for (const fd of p.fields) {
      const { node, focus } = input(fd);
      const error = h("p", { class: "oaf-error", id: uid(fd.id, "-error") });
      const group = ["choice", "choices", "yes_no", "rating", "scale", "nps"].includes(fd.type);
      const req = fd.required ? h("span", { class: "oaf-req", "aria-hidden": "true", text: "*" }) : null;
      const help = fd.help ? h("span", { class: "oaf-help", id: uid(fd.id, "-help"), text: fd.help }) : null;
      const wrap =
        fd.type === "statement" || fd.type === "consent"
          ? h("div", { class: "oaf-field" }, node, help, error)
          : group
            ? h("fieldset", { class: "oaf-field", "aria-describedby": uid(fd.id, "-error") }, h("legend", {}, fd.label, req), help, node, error)
            : h("div", { class: "oaf-field" }, h("label", { class: "oaf-label", for: uid(fd.id) }, fd.label, req), help, node, error);
      fieldEls.set(fd.id, { wrap, error, focus });
      sec.append(wrap);
    }
    pageEls.push(sec);
    el.append(sec);
  });
  el.append(
    h("div", { class: "oaf-hp" }, h("label", { text: "Website" }, honeypot)),
    captchaBox,
    h("div", { class: "oaf-actions" }, back, h("span", {}), next, sendBtn),
    status,
  );

  // A field given in the link and named in ?hide= is answered and not shown.
  const prefilledHidden = new Set((o.hide ?? []).filter((id) => o.values?.[id] !== undefined && answers[id] !== undefined));

  function visible() {
    return shown(form, answers);
  }

  function refresh() {
    const s = visible();
    const ids = new Set(s.fields.map((x) => x.id));
    pageEls.forEach((p, i) => p.classList.toggle("oaf-hidden", i !== page));
    for (const [id, x] of fieldEls) x.wrap.classList.toggle("oaf-hidden", !ids.has(id) || prefilledHidden.has(id));
    const at = s.pages.indexOf(page);
    const last = at === s.pages.length - 1;
    back.classList.toggle("oaf-hidden", !trail.length);
    next.classList.toggle("oaf-hidden", last);
    sendBtn.classList.toggle("oaf-hidden", !last);
    captchaBox.classList.toggle("oaf-hidden", !last);
    if (form.pages.length > 1) {
      steps.textContent = w.step.replace("{n}", String(at + 1)).replace("{m}", String(s.pages.length));
      bar.style.width = `${Math.round(((at + 1) / s.pages.length) * 100)}%`;
    }
    if (last && form.spam.captcha) loadCaptcha();
  }

  function showErrors() {
    for (const [id, x] of fieldEls) {
      const e = errors[id];
      const msg = !e ? "" : e in w ? w[e as ErrorCode] : e;
      const fd = fieldOf(id);
      x.error.textContent = e === "pattern" && fd?.patternMessage ? fd.patternMessage : msg;
      x.wrap.querySelectorAll("input,textarea,select").forEach((i) => (e ? i.setAttribute("aria-invalid", "true") : i.removeAttribute("aria-invalid")));
    }
  }

  /** Checks the page shown; marks what is wrong and moves to the first. */
  function checkPage(upTo: number): boolean {
    const r = validate(form, answers, upTo);
    const onPage = (e: FieldError) => form.pages[page]!.fields.some((x) => x.id === e.field) || upTo === Infinity;
    errors = Object.fromEntries(r.errors.filter(onPage).map((e) => [e.field, e.code]));
    showErrors();
    const first = Object.keys(errors)[0];
    if (first) {
      say(w.fix, true);
      fieldEls.get(first)?.focus();
      return false;
    }
    say("");
    return true;
  }

  function go(to: number) {
    page = to;
    keep();
    refresh();
    (pageEls[page]!.querySelector("input,select,textarea") as HTMLElement | null)?.focus();
  }

  next.addEventListener("click", () => {
    if (!checkPage(page)) return;
    const s = visible();
    const to = s.pages[s.pages.indexOf(page) + 1];
    if (to === undefined) return;
    trail.push(page);
    go(to);
    void save();
  });
  back.addEventListener("click", () => {
    const to = trail.pop();
    if (to !== undefined) go(to);
  });

  async function save() {
    if (o.preview || form.partials === "off") return;
    // With partials: answers, what was written so far is kept (never files or consent boxes); with progress, only
    // which pages were reached and which fields answered.
    const valid = Object.keys(answers).filter((k) => {
      const fd = fieldOf(k);
      return fd && !["file", "consent", "statement"].includes(fd.type) && check(fd, answers[k]).value !== undefined;
    });
    const body =
      form.partials === "answers" ? { answers: Object.fromEntries(valid.map((k) => [k, answers[k]!])) } : { answered: valid, pages: [...trail, page] };
    try {
      await f(`${api}/progress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: form.token, page, language: form.language, ...body }),
        keepalive: true,
      });
    } catch {
      // How far someone got is worth little next to their answer; it is not tried again.
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && started && !el.dataset.sent) void save();
  });

  // Proof of work, started at once so it is done before people are.
  if (form.spam.proofOfWork && !o.preview) proof = work(form.token, form.spam.proofOfWork);

  let captchaLoaded = false;
  function loadCaptcha() {
    const c = form.spam.captcha;
    if (!c || captchaLoaded || o.preview) return;
    captchaLoaded = true;
    const g = window as unknown as Record<string, { render: (el: HTMLElement, o: Record<string, unknown>) => void } | undefined>;
    const name = c.provider === "turnstile" ? "turnstile" : "hcaptcha";
    const draw = () =>
      g[name]?.render(captchaBox, { sitekey: c.siteKey, callback: (t: string) => (captchaToken = t), "expired-callback": () => (captchaToken = null) });
    if (g[name]) return draw();
    const s = document.createElement("script");
    s.src =
      c.provider === "turnstile" ? "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" : "https://js.hcaptcha.com/1/api.js?render=explicit";
    s.async = true;
    s.addEventListener("load", draw);
    document.head.append(s);
  }

  // Send: checked here first, then a real submit event (which Analytics counts), then the answer.
  sendBtn.addEventListener("click", () => {
    if (!checkPage(Infinity)) {
      const first = Object.keys(errors)[0]!;
      const pg = form.pages.findIndex((p) => p.fields.some((x) => x.id === first));
      if (pg !== page && pg >= 0) {
        go(pg);
        fieldEls.get(first)?.focus();
      }
      return;
    }
    if (form.spam.captcha && !captchaToken && !o.preview) return say(w.captcha, true);
    el.requestSubmit();
  });

  el.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send();
  });

  async function send() {
    if (sendBtn.disabled) return;
    sendBtn.disabled = true;
    sendBtn.textContent = w.sending;
    try {
      if (o.preview) return done(form.thanks || w.thanks, null, w.preview);
      if (proof) say(w.checking);
      const nonce = proof ? await proof : undefined;
      const res = await f(`${api}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: form.token,
          answers,
          language: form.language,
          page: o.page ?? { url: location.href, referrer: document.referrer },
          website: honeypot.value,
          versions,
          ...(nonce !== undefined && { proof: nonce }),
          ...(captchaToken && { captcha: captchaToken }),
        }),
      });
      const b = (await res.json().catch(() => null)) as { code?: string; errors?: FieldError[]; thanks?: string; redirect?: string | null } | null;
      if (res.ok) {
        try {
          sessionStorage.removeItem(store);
        } catch {
          // Storage may be blocked.
        }
        // An event of the site's own for OpenAsy Analytics, when its script is on the page: the form's id, no answer.
        tracker()?.track?.("form_submit", { form: form.id });
        return done(b?.thanks || form.thanks || w.thanks, b?.redirect ?? null);
      }
      if (b?.code === "invalid-answers" && b.errors?.length) {
        errors = Object.fromEntries(b.errors.map((e) => [e.field, e.code]));
        showErrors();
        const pg = form.pages.findIndex((p) => p.fields.some((x) => x.id === b.errors![0]!.field));
        if (pg >= 0 && pg !== page) go(pg);
        fieldEls.get(b.errors[0]!.field)?.focus();
        return say(w.fix, true);
      }
      say(
        b?.code === "expired" || b?.code === "invalid-token"
          ? w.expired
          : b?.code === "rate-limited"
            ? w.wait
            : b?.code === "closed"
              ? w.closed
              : b?.code === "captcha-failed"
                ? w.captcha
                : w.network,
        true,
      );
    } catch {
      say(w.network, true);
    } finally {
      if (!el.dataset.sent) {
        sendBtn.disabled = false;
        sendBtn.textContent = form.submit || w.send;
      }
    }
  }

  function done(text: string, redirect: string | null, note?: string) {
    el.dataset.sent = "1";
    if (redirect) {
      try {
        (window.top ?? window).location.assign(redirect);
      } catch {
        location.assign(redirect);
      }
      return;
    }
    el.innerHTML = "";
    el.append(
      h("h2", { class: "oaf-title", id: `oaf-${form.id}-title`, text: form.title }),
      h("p", { class: "oaf-done", role: "status", tabindex: "-1", text }),
    );
    if (note) el.append(h("p", { class: "oaf-help", text: note }));
    (el.querySelector(".oaf-done") as HTMLElement).focus();
  }

  refresh();
  // A view, for OpenAsy Analytics when its script is on the page: the form's id, no answer.
  if (!o.preview) tracker()?.track?.("form_view", { form: form.id });
  return { el, answers, display: (id: string) => display(fieldOf(id), answers[id], w.yes, w.no) };
}

/** Answers the page itself gives: its address's query, then the element's data-value-<field> attributes. */
function givenValues(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(location.search).forEach((v, k) => {
    if (/^[a-z][a-z0-9_]{0,39}$/.test(k) && k !== "hide" && k !== "lang") out[k] = v;
  });
  for (const a of Array.from(el.attributes)) if (a.name.startsWith("data-value-")) out[a.name.slice(11)] = a.value;
  return out;
}

/** Loads a form: from the JSON the form's own page carries, else from Forms. */
function load(endpoint: string, id: string, lang?: string): Promise<PublicForm> {
  const inline = document.getElementById(`openasy-form-${id}`);
  if (inline?.textContent) return Promise.resolve(JSON.parse(inline.textContent) as PublicForm);
  return fetch(`${endpoint}/api/v1/public/forms/${encodeURIComponent(id)}?${new URLSearchParams(lang ? { lang } : {})}`).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json() as Promise<PublicForm>;
  });
}

const POPUP = `.oaf-popup{border:0;border-radius:12px;padding:24px;max-width:min(640px,calc(100vw - 32px));width:100%;color:#16181d;background:#fff}
.oaf-popup::backdrop{background:rgba(0,0,0,.45)}
.oaf-popup .oaf-close{float:right;margin:-8px -8px 0 8px}
@media (prefers-color-scheme:dark){.oaf-popup{color:#e8eaed;background:#1a1d23}}`;

/**
 * Finds the tag that loaded the script and every data-openasy-form element, and draws each form once: in the page, or
 * with data-mode="popup" as a button (data-button, its words) that opens the form in a dialog.
 */
export function start(script: HTMLScriptElement | null = document.currentScript as HTMLScriptElement | null) {
  const endpoint = script?.src ? new URL(script.src, location.href).origin : location.origin;
  if (script?.dataset.form) {
    const box = document.createElement("div");
    box.setAttribute("data-openasy-form", script.dataset.form);
    for (const a of Array.from(script.attributes))
      if (a.name.startsWith("data-value-") || ["data-lang", "data-mode", "data-button"].includes(a.name)) box.setAttribute(a.name, a.value);
    script.after(box);
  }
  const hide = (new URLSearchParams(location.search).get("hide") ?? "").split(",").filter(Boolean);
  document.querySelectorAll<HTMLElement>("[data-openasy-form]").forEach((el) => {
    if (el.dataset.mounted) return;
    el.dataset.mounted = "1";
    const id = el.dataset.openasyForm!;
    const options: Options = { endpoint, lang: el.dataset.lang, preview: el.dataset.preview === "1", values: givenValues(el), hide };
    const words = WORDS[(["en", "tr", "de"].includes(options.lang ?? "") ? options.lang : "en") as Lang];
    const draw = (into: HTMLElement) =>
      load(endpoint, id, options.lang).then(
        (form) => mount(into, form, options),
        () => {
          into.textContent = words.loadFailed;
        },
      );
    if (el.dataset.mode !== "popup") return void draw(el);
    if (!document.getElementById("oaf-popup-style")) document.head.append(h("style", { id: "oaf-popup-style", text: POPUP }));
    const open = h("button", { type: "button", class: "oaf-btn", text: el.dataset.button || "Open the form" }) as HTMLButtonElement;
    const dialog = h("dialog", { class: "oaf-popup", "aria-label": el.dataset.button || id }) as HTMLDialogElement;
    const close = h("button", { type: "button", class: "oaf-btn oaf-ghost oaf-small oaf-close", "aria-label": "×", text: "×" }) as HTMLButtonElement;
    const inner = h("div");
    dialog.append(close, inner);
    el.append(open, dialog);
    let drawn = false;
    open.addEventListener("click", () => {
      if (!drawn) ((drawn = true), void draw(inner));
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    });
    close.addEventListener("click", () => (typeof dialog.close === "function" ? dialog.close() : dialog.removeAttribute("open")));
  });
}
