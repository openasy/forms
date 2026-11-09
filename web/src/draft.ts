// The form builder works on the form's YAML, as the file has it: a change here edits that text (keeping its comments
// and the other languages' words), and Save as YAML hands it back to be committed. Nothing here writes to Forms; a
// form changes when its file does. The preview draws the draft with the same script the form's page uses.
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import type { PublicForm } from "../../server/logic.ts";
import type { Kind } from "./api.ts";

type Path = Array<string | number>;
type Raw = Record<string, unknown>;

export interface Draft {
  doc: Document;
  /** Where the form's map is: the root of its own file, or forms.<id> in forms.yaml. */
  base: Path;
  id: string;
  /** The file the form is kept in. */
  file: string;
  /** The language the builder writes questions in. */
  lang: string;
}

export function openDraft(yaml: string, id: string, file: string, lang: string): Draft {
  const doc = parseDocument(yaml);
  return { doc, base: file === "forms.yaml" ? ["forms", id] : [], id, file, lang };
}

// The starter questions are written in all three languages, so the form reads right whichever one a visitor uses.
const KINDS: Record<Kind, Raw> = {
  lead: {
    kind: "lead",
    fields: [
      { id: "name", type: "text", label: { en: "Name", tr: "Ad soyad", de: "Name" }, required: true },
      { id: "email", type: "email", label: { en: "Work email", tr: "İş e-postası", de: "Geschäftliche E-Mail" }, required: true },
      { id: "company", type: "text", label: { en: "Company", tr: "Şirket", de: "Unternehmen" } },
      { id: "message", type: "textarea", label: { en: "Anything else?", tr: "Eklemek istediğiniz bir şey var mı?", de: "Sonst noch etwas?" } },
    ],
    send_to: { crm: true },
  },
  contact: {
    kind: "contact",
    fields: [
      { id: "name", type: "text", label: { en: "Name", tr: "Ad soyad", de: "Name" } },
      { id: "email", type: "email", label: { en: "Email", tr: "E-posta", de: "E-Mail" }, required: true },
      { id: "message", type: "textarea", label: { en: "Message", tr: "Mesaj", de: "Nachricht" }, required: true },
    ],
    send_to: { helpdesk: true },
  },
  nps: {
    kind: "nps",
    fields: [
      {
        id: "score",
        type: "nps",
        label: {
          en: "How likely are you to recommend us to a colleague?",
          tr: "Bizi bir iş arkadaşınıza önerme olasılığınız nedir?",
          de: "Wie wahrscheinlich ist es, dass Sie uns einer Kollegin oder einem Kollegen empfehlen?",
        },
        required: true,
      },
      {
        id: "why",
        type: "textarea",
        label: { en: "What should we do better?", tr: "Neyi daha iyi yapmalıyız?", de: "Was sollten wir besser machen?" },
        show_if: { field: "score", below: 9 },
      },
    ],
  },
  survey: {
    kind: "survey",
    fields: [
      { id: "rating", type: "rating", label: { en: "How was it?", tr: "Nasıldı?", de: "Wie war es?" }, required: true },
      { id: "comment", type: "textarea", label: { en: "Anything to add?", tr: "Eklemek istediğiniz bir şey var mı?", de: "Möchten Sie noch etwas ergänzen?" } },
    ],
  },
};

/** A new form, in a file of its own, with the fields every form of its kind needs. */
export function newDraft(id: string, name: string, kind: Kind, lang: string): Draft {
  const doc = parseDocument("{}");
  doc.contents = doc.createNode({ name, ...KINDS[kind] }) as typeof doc.contents;
  return { doc, base: [], id, file: `forms/${id}.yaml`, lang };
}

/** "Payroll export interest" is payroll-export-interest, with Turkish letters written plainly. */
export function slug(name: string): string {
  return name
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

export const form = (d: Draft): Raw => {
  const v = d.doc.getIn(d.base, false) as { toJSON?: () => unknown } | undefined;
  return ((isMap(v) ? v.toJSON() : {}) ?? {}) as Raw;
};
const multi = (d: Draft) => Array.isArray(form(d).pages);
const fieldsPath = (d: Draft, page: number): Path => (multi(d) ? [...d.base, "pages", page, "fields"] : [...d.base, "fields"]);

export interface DraftField {
  page: number;
  index: number;
  id: string;
  type: string;
  label: string;
  help: string;
  required: boolean;
  options: string[];
  showIf: unknown;
}

/** A text of the file in the builder's language: one text, or the language's in a map of en, tr and de. */
export function textOf(v: unknown, lang: string): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const m = v as Record<string, string>;
    return m[lang] ?? m.en ?? Object.values(m)[0] ?? "";
  }
  return v === undefined || v === null ? "" : String(v);
}

export function pagesOf(d: Draft): Array<{ title: string; showIf: unknown; fields: DraftField[] }> {
  const f = form(d);
  const pages = (multi(d) ? (f.pages as Raw[]) : [{ fields: f.fields }]) ?? [];
  return pages.map((p, page) => ({
    title: textOf(p.title, d.lang),
    showIf: p.show_if,
    fields: ((p.fields as Raw[] | undefined) ?? []).map((x, index) => ({
      page,
      index,
      id: String(x.id ?? (x.type === "statement" ? `statement_${index}` : "")),
      type: String(x.type ?? "text"),
      label: textOf(x.label ?? x.text, d.lang),
      help: textOf(x.help, d.lang),
      required: x.required === true,
      options: Array.isArray(x.options) ? x.options.map((o) => (o && typeof o === "object" ? String((o as Raw).value) : String(o))) : [],
      showIf: x.show_if,
    })),
  }));
}

/** Sets a field's question or help in the builder's language, keeping the other languages' words. */
export function setText(d: Draft, page: number, index: number, key: "label" | "help", value: string) {
  const at = [...fieldsPath(d, page), index, key];
  const node = d.doc.getIn(at, true);
  if (!value.trim() && key === "help") return void d.doc.deleteIn(at);
  if (isMap(node)) d.doc.setIn([...at, d.lang], value);
  else d.doc.setIn(at, value);
}

export function setRequired(d: Draft, page: number, index: number, required: boolean) {
  const at = [...fieldsPath(d, page), index, "required"];
  if (required) d.doc.setIn(at, true);
  else d.doc.deleteIn(at);
}

export function move(d: Draft, page: number, index: number, by: -1 | 1) {
  const seq = d.doc.getIn(fieldsPath(d, page), true);
  if (!isSeq(seq)) return;
  const j = index + by;
  if (j < 0 || j >= seq.items.length) return;
  [seq.items[index], seq.items[j]] = [seq.items[j]!, seq.items[index]!];
}

export function addField(d: Draft, page: number, field: Raw) {
  d.doc.addIn(fieldsPath(d, page), d.doc.createNode(field));
}

export function removeField(d: Draft, page: number, index: number) {
  d.doc.deleteIn([...fieldsPath(d, page), index]);
}

/** Shows a field only when an earlier answer is one of `values`. */
export function setRule(d: Draft, page: number, index: number, when: string, values: string[]) {
  const cond = values.length === 1 ? { field: when, is: values[0] } : { field: when, in: values };
  d.doc.setIn([...fieldsPath(d, page), index, "show_if"], d.doc.createNode(cond));
}

export function ids(d: Draft): string[] {
  return pagesOf(d).flatMap((p) => p.fields.map((f) => f.id));
}

export const toText = (d: Draft) => d.doc.toString({ lineWidth: 0 });

/** The draft as the form script draws it, for the preview. Values the file would refuse are drawn as best they can be. */
export function preview(d: Draft, endpoint: string): PublicForm {
  const f = form(d);
  const lang = d.lang;
  const t = (v: unknown) => textOf(v, lang) || null;
  const list = (v: unknown) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]) as PublicForm["pages"][number]["showIf"];
  const pages = (multi(d) ? (f.pages as Raw[]) : [{ fields: f.fields }]) ?? [];
  return {
    id: d.id,
    name: String(f.name ?? d.id),
    kind: (f.kind as Kind) ?? "contact",
    language: ["en", "tr", "de"].includes(lang) ? lang : "en",
    title: t(f.title) ?? String(f.name ?? d.id),
    description: t(f.description),
    pages: pages.map((p) => ({
      title: t(p.title),
      description: t(p.description),
      showIf: list(p.show_if),
      fields: ((p.fields as Raw[] | undefined) ?? []).map((x, i) => {
        const type = String(x.type ?? "text") as PublicForm["pages"][number]["fields"][number]["type"];
        return {
          id: String(x.id ?? `statement_${i}`),
          type,
          label: t(x.label ?? x.text) ?? "",
          help: t(x.help),
          placeholder: t(x.placeholder),
          required: x.required === true,
          min: type === "scale" ? Number(x.min ?? 1) : typeof x.min === "number" ? x.min : null,
          max: type === "rating" || type === "scale" ? Number(x.max ?? 5) : typeof x.max === "number" ? x.max : null,
          pattern: null,
          patternMessage: null,
          options: Array.isArray(x.options)
            ? x.options.map((o) =>
                o && typeof o === "object"
                  ? { value: String((o as Raw).value), label: t((o as Raw).label) ?? String((o as Raw).value) }
                  : { value: String(o), label: String(o) },
              )
            : [],
          minLabel: t(x.min_label),
          maxLabel: t(x.max_label),
          accept: [],
          maxSize: null,
          consent: type === "consent" ? { purpose: String(x.purpose ?? ""), channels: (x.channels as string[]) ?? ["email"], version: null } : null,
          showIf: list(x.show_if),
        };
      }),
    })),
    hidden: Array.isArray(f.hidden) ? f.hidden.map(String) : [],
    submit: t(f.submit) ?? "",
    thanks: "",
    redirect: null,
    closed: null,
    closedText: null,
    token: "preview",
    spam: { honeypot: "website", proofOfWork: null, captcha: null },
    partials: "off",
    endpoint,
  };
}
