// The Forms page and a form's page: every form with its answers this week and where they went, and one form's
// fields, rules, embed code and destinations. A form is its YAML file: the builder edits a draft of that text in the
// browser, the preview draws the draft with the form script, and Save as YAML gives the text to commit.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  Switch,
  Tabs,
  TextField,
  Checkbox,
  type Column,
  type Tone,
} from "@openasy/ui";
import {
  AlignLeft,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  AtSign,
  CalendarDays,
  CircleDot,
  Code as CodeIcon,
  Copy,
  ExternalLink,
  Gauge,
  Hash,
  Link2,
  ListChecks,
  Paperclip,
  Phone,
  Plus,
  ShieldCheck,
  SquareChevronDown,
  Star,
  Trash2,
  Type,
  ToggleLeft,
  SlidersHorizontal,
  Text as TextIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { mount } from "../../page/f.ts";
import type { FormDetail, FormSummary, Kind, Target } from "./api.ts";
import { Code, copy, fmt, pct, targetName, useLoad, type Call } from "./common.tsx";
import {
  addField,
  ids,
  move,
  newDraft,
  openDraft,
  pagesOf,
  preview,
  removeField,
  setRequired,
  setRule,
  setText,
  slug,
  toText,
  type Draft,
  type DraftField,
} from "./draft.ts";
import { useT, type T } from "./i18n.ts";

const KINDS: Kind[] = ["lead", "contact", "nps", "survey"];
const STATE_TONE: Record<string, Tone> = { open: "success", closed: "warning", full: "warning", draft: "neutral" };

const TYPES = [
  "text",
  "textarea",
  "email",
  "phone",
  "number",
  "url",
  "date",
  "choice",
  "choices",
  "select",
  "yes_no",
  "rating",
  "scale",
  "nps",
  "file",
  "consent",
  "statement",
] as const;
type FieldType = (typeof TYPES)[number];
const ICONS: Record<FieldType, typeof Type> = {
  text: Type,
  textarea: AlignLeft,
  email: AtSign,
  phone: Phone,
  number: Hash,
  url: Link2,
  date: CalendarDays,
  choice: CircleDot,
  choices: ListChecks,
  select: SquareChevronDown,
  yes_no: ToggleLeft,
  rating: Star,
  scale: SlidersHorizontal,
  nps: Gauge,
  file: Paperclip,
  consent: ShieldCheck,
  statement: TextIcon,
};
const typeOf = (t: string): FieldType => ((TYPES as readonly string[]).includes(t) ? (t as FieldType) : "text");

// ---------------------------------------------------------------- drafts kept in this browser

/** New forms made here are drafts in this browser until their file is committed; they are kept across reloads. */
interface StoredDraft {
  id: string;
  name: string;
  kind: Kind;
  yaml: string;
}
const DRAFTS = "openasy-forms:drafts";
export function loadDrafts(): StoredDraft[] {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS) ?? "[]") as StoredDraft[];
  } catch {
    return [];
  }
}
function saveDrafts(list: StoredDraft[]) {
  try {
    localStorage.setItem(DRAFTS, JSON.stringify(list));
  } catch {
    // Storage may be blocked; the draft lives as long as the page.
  }
}

// ---------------------------------------------------------------- the list

export function FormsPage({ call, language }: { call: Call; language: string }) {
  const t = useT();
  const [data] = useLoad<{ forms: FormSummary[] }>(call, "/api/v1/forms");
  const [kind, setKind] = useState<"all" | Kind>("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState(loadDrafts);
  const forms = data?.forms ?? [];
  const known = new Set(forms.map((f) => f.id));
  const draftRows: Array<FormSummary & { draft: true }> = drafts
    .filter((d) => !known.has(d.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      title: d.name,
      state: "open",
      closes: null,
      limit: null,
      pages: 1,
      fields: 0,
      languages: [language],
      week: { views: 0, submitted: 0, partial: 0, leads: 0, consent: null, spam: 0, completion: null },
      total: 0,
      lastAt: null,
      nps: null,
      destinations: [],
      file: `forms/${d.id}.yaml`,
      embedOn: [],
      url: "",
      draft: true,
    }));
  const all: Array<FormSummary & { draft?: true }> = [...draftRows, ...forms];
  const rows = all.filter((f) => (kind === "all" || f.kind === kind) && `${f.name} ${f.id}`.toLocaleLowerCase("tr").includes(query.toLocaleLowerCase("tr")));
  const sum = (k: keyof FormSummary["week"]) => forms.reduce((n, f) => n + Number(f.week[k] ?? 0), 0);
  const withBoxes = forms.filter((f) => f.week.consent !== null);
  const ticked = withBoxes.reduce((n, f) => n + (f.week.consent ?? 0), 0);
  const sentWithBoxes = withBoxes.reduce((n, f) => n + f.week.submitted, 0);
  const stateLabel = (f: FormSummary & { draft?: true }) => (f.draft ? t("state.draft") : t(`state.${f.state}`));
  const cols: Column<FormSummary & { draft?: true }>[] = [
    {
      id: "name",
      header: t("forms.form"),
      width: "30%",
      sortValue: (f) => f.name,
      cell: (f) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{f.name}</span>
          <span className="truncate text-2xs text-fg-muted">
            {f.draft ? t("forms.notShown") : f.embedOn.length ? t("forms.embeddedOn", { hosts: f.embedOn.join(", ") }) : t("forms.ownPage")}
          </span>
        </span>
      ),
    },
    { id: "kind", header: t("forms.kind"), cell: (f) => <Badge>{t(`kind.${f.kind}`)}</Badge> },
    { id: "state", header: t("forms.state"), cell: (f) => <StatusBadge tone={f.draft ? "neutral" : STATE_TONE[f.state]!}>{stateLabel(f)}</StatusBadge> },
    { id: "answers", header: t("forms.answers7"), align: "right", mono: true, sortValue: (f) => f.week.submitted, cell: (f) => fmt(f.week.submitted) },
    {
      id: "rate",
      header: t("forms.ofViews"),
      description: t("forms.ofViewsDetail"),
      align: "right",
      mono: true,
      cell: (f) => pct(f.week.submitted, f.week.views),
    },
    {
      id: "to",
      header: t("forms.sendsTo"),
      cell: (f) =>
        f.destinations.length ? (
          <span className="flex flex-wrap gap-1">
            {f.destinations.map((d) => (
              <Badge key={`${d.target}:${d.name ?? ""}`} tone={d.failed ? "danger" : "info"}>
                {targetName(t, d.target, d.name)}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-xs text-fg-muted">{t("forms.keptHere")}</span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("forms.title")}
        description={t("forms.description")}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            {t("forms.new")}
          </Button>
        }
      />
      {data === null && <EmptyState title={t("common.failed")} />}
      <KpiGrid minWidth={170} className="my-2.5">
        <KpiCard label={t("forms.answers7")} value={fmt(sum("submitted"))} delta={{ label: t("forms.partialN", { n: sum("partial") }), intent: "neutral" }} />
        <KpiCard
          label={t("forms.ofViews")}
          value={pct(sum("submitted"), sum("views"))}
          delta={{ label: t("forms.viewsN", { n: fmt(sum("views")) }), intent: "neutral" }}
        />
        <KpiCard label={t("forms.leads")} value={fmt(sum("leads"))} delta={{ label: t("forms.leadsDetail"), intent: "neutral" }} />
        <KpiCard
          label={t("forms.consent")}
          value={withBoxes.length ? pct(ticked, sentWithBoxes) : "–"}
          delta={{ label: t("forms.consentDetail"), intent: "neutral" }}
        />
        <KpiCard label={t("forms.spam")} value={fmt(sum("spam"))} delta={{ label: t("forms.spamDetail"), intent: "neutral" }} />
      </KpiGrid>
      <Panel flush>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <SegmentedControl
            label={t("forms.kind")}
            value={kind}
            onChange={setKind}
            options={[{ value: "all" as const, label: t("forms.all") }, ...KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))]}
          />
          <SearchInput label={t("forms.search")} value={query} onChange={(e) => setQuery(e.target.value)} className="w-60" />
        </div>
        <div className="border-t border-line">
          <DataTable
            label={t("forms.title")}
            columns={cols}
            rows={rows}
            getRowId={(f) => f.id}
            onRowClick={(f) => navigate(`/forms/${f.id}`)}
            minWidth={820}
            loading={data === undefined}
            empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("forms.none")}</p>}
          />
        </div>
      </Panel>
      <NewFormDialog
        open={creating}
        onOpenChange={setCreating}
        taken={(id) => known.has(id) || drafts.some((d) => d.id === id)}
        onCreate={(d) => {
          const list = [d, ...drafts];
          saveDrafts(list);
          setDrafts(list);
          setCreating(false);
          navigate(`/forms/${d.id}`);
        }}
        language={language}
      />
    </>
  );
}

function NewFormDialog({
  open,
  onOpenChange,
  onCreate,
  taken,
  language,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (d: StoredDraft) => void;
  taken: (id: string) => boolean;
  language: string;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("lead");
  const id = slug(name);
  const clash = !!id && taken(id);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("forms.new")}
      description={t("forms.newDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!id || clash) return;
        onCreate({ id, name: name.trim(), kind, yaml: toText(newDraft(id, name.trim(), kind, language)) });
        setName("");
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!id || clash}>
            {t("forms.create")}
          </Button>
        </>
      }
    >
      <TextField
        label={t("forms.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("forms.namePlaceholder")}
        hint={clash ? t("forms.taken", { id }) : id ? `forms/${id}.yaml` : undefined}
      />
      <SelectField
        label={t("forms.kind")}
        value={kind}
        onChange={(e) => setKind(e.target.value as Kind)}
        options={KINDS.map((k) => ({ value: k, label: t(`kind.${k}Detail`) }))}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------- one form

type EditorTab = "fields" | "logic" | "share" | "routing";
const TABS: EditorTab[] = ["fields", "logic", "share", "routing"];

export function FormPage({ call, id, tab: initialTab, language }: { call: Call; id: string; tab?: string; language: string }) {
  const t = useT();
  const [detail] = useLoad<FormDetail>(call, `/api/v1/forms/${encodeURIComponent(id)}`);
  const stored = loadDrafts().find((d) => d.id === id);
  if (detail === undefined && !stored) return <PageHeader title={t("loading")} />;
  if (!detail && !stored) return <EmptyState title={t("form.missing", { id })}>{t("form.missingDetail")}</EmptyState>;
  return (
    <FormEditor
      key={detail?.yaml ?? stored?.yaml}
      detail={detail ?? null}
      stored={stored}
      initialTab={TABS.includes(initialTab as EditorTab) ? (initialTab as EditorTab) : "fields"}
      language={language}
    />
  );
}

function FormEditor({ detail, stored, initialTab, language }: { detail: FormDetail | null; stored?: StoredDraft; initialTab: EditorTab; language: string }) {
  const t = useT();
  const fileLang = detail?.language ?? language;
  const [draft] = useState<Draft>(() =>
    detail ? openDraft(detail.yaml, detail.id, detail.file, fileLang) : openDraft(stored!.yaml, stored!.id, `forms/${stored!.id}.yaml`, language),
  );
  const [rev, setRev] = useState(0);
  const changed = () => {
    setRev((n) => n + 1);
    if (!detail && stored) saveDrafts(loadDrafts().map((d) => (d.id === stored.id ? { ...d, yaml: toText(draft) } : d)));
  };
  const [tab, setTabState] = useState<EditorTab>(initialTab);
  const setTab = (x: EditorTab) => {
    setTabState(x);
    history.replaceState(null, "", `/forms/${draft.id}${x === "fields" ? "" : `?tab=${x}`}`);
  };
  const [yaml, setYaml] = useState(false);
  const [copied, setCopied] = useState(false);
  // The draft changes in place; rev counts the changes, and each one draws the page again.
  const pages = pagesOf(draft);
  const rules = pages.flatMap((p, i) => [
    ...(p.showIf ? [{ page: i, field: null as DraftField | null, cond: p.showIf }] : []),
    ...p.fields.filter((f) => f.showIf).map((f) => ({ page: i, field: f, cond: f.showIf })),
  ]);
  const name = detail?.name ?? stored!.name;
  const kind = detail?.kind ?? stored!.kind;
  const dirty = rev > 0;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("forms.title"), href: "/forms" }, { label: name }]}
        title={name}
        meta={
          <>
            <StatusBadge tone={detail ? STATE_TONE[detail.state]! : "neutral"}>{detail ? t(`state.${detail.state}`) : t("state.draft")}</StatusBadge>
            <Badge>{t(`kind.${kind}`)}</Badge>
          </>
        }
        actions={
          <>
            <Button icon={<ArrowLeft />} onClick={() => navigate("/forms")}>
              {t("form.back")}
            </Button>
            {detail && (
              <Button icon={<ExternalLink />} onClick={() => window.open(detail.url, "_blank", "noopener")}>
                {t("form.open")}
              </Button>
            )}
            <Button variant="primary" icon={<CodeIcon />} onClick={() => setYaml(true)}>
              {t("form.saveYaml")}
            </Button>
          </>
        }
      >
        <Tabs
          label={t("form.tabs")}
          value={tab}
          onChange={setTab}
          items={[
            { value: "fields", label: t("form.fields"), count: pages.reduce((n, p) => n + p.fields.length, 0) },
            { value: "logic", label: t("form.logic"), count: rules.length },
            { value: "share", label: t("form.share") },
            { value: "routing", label: t("form.routing") },
          ]}
        />
      </PageHeader>
      <Callout tone="info" title={t("form.keptIn", { file: draft.file })} className="my-2.5">
        {dirty || !detail ? t("form.draftDetail") : t("form.fileDetail")}
      </Callout>
      {tab === "fields" && <FieldsTab draft={draft} pages={pages} detail={detail} onChange={changed} rev={rev} />}
      {tab === "logic" && <LogicTab draft={draft} pages={pages} rules={rules} detail={detail} onChange={changed} />}
      {tab === "share" && <ShareTab id={draft.id} detail={detail} />}
      {tab === "routing" && <RoutingTab detail={detail} />}
      <Dialog
        open={yaml}
        onOpenChange={(o) => {
          setYaml(o);
          setCopied(false);
        }}
        title={draft.file}
        description={t("form.yamlDetail")}
        size="lg"
        footer={
          <>
            {copied && (
              <span role="status" className="mr-auto self-center text-xs text-success">
                {t("common.copied")}
              </span>
            )}
            <Button type="button" icon={<Copy />} variant="primary" onClick={() => void copy(toText(draft)).then(setCopied)}>
              {t("common.copy")}
            </Button>
          </>
        }
      >
        <Code label={t("form.yamlLabel")}>{toText(draft)}</Code>
      </Dialog>
    </>
  );
}

/** What the server checks of each type, as people read it. */
function checks(t: T, type: FieldType) {
  return t(`type.${type}Check`);
}

function FieldsTab({
  draft,
  pages,
  detail,
  onChange,
  rev,
}: {
  draft: Draft;
  pages: ReturnType<typeof pagesOf>;
  detail: FormDetail | null;
  onChange: () => void;
  rev: number;
}) {
  const t = useT();
  const [page, setPage] = useState(0);
  const onPage = pages[page]?.fields ?? [];
  const [selected, setSelected] = useState(onPage[0]?.id ?? "");
  const [adding, setAdding] = useState(false);
  const cur = pages.flatMap((p) => p.fields).find((f) => f.id === selected);
  const hidden = detail?.definition.hidden ?? [];
  const consent = detail?.sendTo.consent.find((c) => c.field === cur?.id);
  return (
    <div className="forms-thirds grid gap-2.5">
      <Panel
        aria-label={t("form.fields")}
        title={t("form.fields")}
        description={t("form.fieldsOn", { fields: pages.reduce((n, p) => n + p.fields.length, 0), pages: pages.length })}
        actions={
          <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
            {t("form.addField")}
          </Button>
        }
      >
        {pages.length > 1 && (
          <SegmentedControl
            label={t("form.page")}
            value={String(page)}
            onChange={(v) => setPage(Number(v))}
            options={pages.map((p, i) => ({ value: String(i), label: `${i + 1}. ${p.title || t("form.pageN", { n: i + 1 })}` }))}
            className="mb-2"
          />
        )}
        <ol aria-label={t("form.fieldsOnPage")} className="forms-list flex flex-col gap-1">
          {onPage.map((f) => {
            const Icon = ICONS[typeOf(f.type)];
            return (
              <li key={`${f.id}:${f.index}`} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={f.id === selected}
                  onClick={() => setSelected(f.id)}
                  className={`flex min-w-0 grow items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm ${f.id === selected ? "border-accent bg-accent-soft text-accent-text" : "border-line text-fg hover:bg-canvas"}`}
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 grow truncate">{f.label || f.id}</span>
                  {f.required && <Badge>{t("form.required")}</Badge>}
                  {!!f.showIf && <Badge tone="info">{t("form.rule")}</Badge>}
                </button>
                <IconButton label={t("form.moveUp", { name: f.label })} size="xs" onClick={() => (move(draft, page, f.index, -1), onChange())}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton label={t("form.moveDown", { name: f.label })} size="xs" onClick={() => (move(draft, page, f.index, 1), onChange())}>
                  <ArrowDown className="size-3.5" />
                </IconButton>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 mb-0 text-xs text-fg-muted">
          {hidden.length ? `${t("form.hiddenFields", { names: hidden.join(", ") })} ` : ""}
          {t("form.prefill")}
        </p>
      </Panel>
      <Panel aria-label={t("form.fieldSettings")} title={t("form.fieldSettings")} description={cur ? t(`type.${typeOf(cur.type)}`) : t("form.pick")}>
        {cur && (
          <div key={`${cur.page}:${cur.index}:${cur.id}`} className="flex flex-col gap-2.5">
            <TextField
              label={t("form.question")}
              defaultValue={cur.label}
              onChange={(e) => (setText(draft, cur.page, cur.index, "label", e.target.value), onChange())}
            />
            <TextField
              label={t("form.help")}
              defaultValue={cur.help}
              placeholder={t("form.helpPlaceholder")}
              onChange={(e) => (setText(draft, cur.page, cur.index, "help", e.target.value), onChange())}
            />
            {cur.type !== "statement" && (
              <Switch
                label={t("form.required")}
                description={t("form.requiredDetail")}
                checked={cur.required}
                onCheckedChange={(v) => (setRequired(draft, cur.page, cur.index, v), onChange())}
              />
            )}
            <div className="flex flex-col gap-0.5 text-xs">
              <span className="font-medium text-fg">{t("form.checked")}</span>
              <span className="text-fg-muted">{checks(t, typeOf(cur.type))}</span>
            </div>
            <div className="flex flex-col gap-0.5 text-xs">
              <span className="font-medium text-fg">{t("form.fieldId")}</span>
              <code className="font-mono text-2xs text-fg-muted">{cur.id}</code>
            </div>
            {!!cur.showIf && <Callout tone="info" title={t("form.shownOnly", { rule: describe(t, cur.showIf, pages) })} />}
            {cur.type === "consent" && (
              <Callout
                tone="info"
                title={
                  consent?.linked
                    ? t("form.consentLinked", { purpose: consent.purpose, channels: consent.channels.join(", "), version: consent.version ?? "?" })
                    : t("form.consentNotLinked")
                }
              >
                {t("form.consentDetail")}
              </Callout>
            )}
            <div>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 />}
                onClick={() => {
                  removeField(draft, cur.page, cur.index);
                  onChange();
                  setSelected(pagesOf(draft)[page]?.fields[0]?.id ?? "");
                }}
              >
                {t("form.remove")}
              </Button>
            </div>
          </div>
        )}
      </Panel>
      <Preview draft={draft} rev={rev} />
      <AddFieldDialog
        open={adding}
        onOpenChange={setAdding}
        taken={ids(draft)}
        onAdd={(f) => {
          addField(draft, page, f);
          onChange();
          setSelected(String(f.id));
          setAdding(false);
        }}
      />
    </div>
  );
}

/** The draft as visitors see it, drawn by the form script itself, in preview: nothing is sent. */
function Preview({ draft, rev }: { draft: Draft; rev: number }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      mount(ref.current, preview(draft, window.location.origin), { endpoint: window.location.origin, preview: true });
    } catch {
      ref.current.textContent = t("form.previewFailed");
    }
  }, [draft, rev, t]);
  return (
    <Panel aria-label={t("form.preview")} title={t("form.preview")} description={t("form.previewDetail")}>
      <div ref={ref} className="forms-preview rounded-md border border-line bg-canvas p-3" />
    </Panel>
  );
}

function AddFieldDialog({
  open,
  onOpenChange,
  onAdd,
  taken,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (f: Record<string, unknown>) => void;
  taken: string[];
}) {
  const t = useT();
  const [type, setType] = useState<FieldType>("text");
  const [label, setLabel] = useState("");
  const [required, setRequiredState] = useState(false);
  const base = slug(label).replace(/-/g, "_") || type;
  let id = /^[a-z]/.test(base) ? base.slice(0, 40) : `f_${base}`.slice(0, 40);
  for (let n = 2; taken.includes(id); n++) id = `${base.slice(0, 36)}_${n}`;
  const options = type === "choice" || type === "choices" || type === "select";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("form.addField")}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        onAdd({
          id,
          type,
          label: label.trim(),
          ...(required && type !== "statement" && { required: true }),
          ...(options && { options: [t("form.option1"), t("form.option2")] }),
          ...(type === "consent" && { purpose: "marketing", channels: ["email"] }),
        });
        setLabel("");
        setRequiredState(false);
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!label.trim()}>
            {t("form.add")}
          </Button>
        </>
      }
    >
      <div role="group" aria-label={t("form.type")} className="forms-types grid gap-1">
        {TYPES.map((x) => {
          const Icon = ICONS[x];
          return (
            <button
              key={x}
              type="button"
              aria-pressed={x === type}
              onClick={() => setType(x)}
              className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs ${x === type ? "border-accent bg-accent-soft text-accent-text" : "border-line text-fg hover:bg-canvas"}`}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              {t(`type.${x}`)}
            </button>
          );
        })}
      </div>
      <p className="m-0 text-xs text-fg-muted">{checks(t, type)}</p>
      <TextField label={t("form.question")} value={label} onChange={(e) => setLabel(e.target.value)} hint={label ? t("form.idHint", { id }) : undefined} />
      {type !== "statement" && <Checkbox label={t("form.required")} checked={required} onChange={(e) => setRequiredState(e.target.checked)} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------- logic

/** A show_if as people read it: "Team size is 51-200 or 200+". */
function describe(t: T, cond: unknown, pages: ReturnType<typeof pagesOf>): string {
  const label = (id: string) => pages.flatMap((p) => p.fields).find((f) => f.id === id)?.label ?? id;
  const one = (c: Record<string, unknown>): string => {
    if (Array.isArray(c.any)) return c.any.map((x) => one(x as Record<string, unknown>)).join(t("logic.or"));
    const f = label(String(c.field));
    const parts: string[] = [];
    if (c.is !== undefined) parts.push(t("logic.is", { field: f, value: String(c.is) }));
    if (c.not !== undefined) parts.push(t("logic.not", { field: f, value: String(c.not) }));
    if (Array.isArray(c.in)) parts.push(t("logic.is", { field: f, value: c.in.join(t("logic.or")) }));
    if (c.above !== undefined) parts.push(t("logic.above", { field: f, value: String(c.above) }));
    if (c.below !== undefined) parts.push(t("logic.below", { field: f, value: String(c.below) }));
    if (c.answered !== undefined) parts.push(c.answered ? t("logic.answered", { field: f }) : t("logic.notAnswered", { field: f }));
    return parts.join(t("logic.and"));
  };
  const list = Array.isArray(cond) ? cond : [cond];
  return list.map((c) => one((c ?? {}) as Record<string, unknown>)).join(t("logic.and"));
}

function LogicTab({
  draft,
  pages,
  rules,
  detail,
  onChange,
}: {
  draft: Draft;
  pages: ReturnType<typeof pagesOf>;
  rules: Array<{ page: number; field: DraftField | null; cond: unknown }>;
  detail: FormDetail | null;
  onChange: () => void;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const all = pages.flatMap((p) => p.fields);
  const targets = all.filter((f) => f.type !== "consent");
  const [show, setShow] = useState(targets.at(-1)?.id ?? "");
  const target = all.find((f) => f.id === show);
  // A rule reads only an earlier answer with options.
  const earlier = target ? all.slice(0, all.indexOf(target)).filter((f) => f.options.length || f.type === "yes_no") : [];
  const [when, setWhen] = useState("");
  const source = earlier.find((f) => f.id === when) ?? earlier[0];
  const values = source ? (source.type === "yes_no" ? ["yes", "no"] : source.options) : [];
  const [is, setIs] = useState<string[]>([]);
  const ownerBy = detail?.sendTo.crm?.ownerBy;
  return (
    <div className="forms-halves grid gap-2.5">
      <Panel
        aria-label={t("logic.rules")}
        title={t("logic.rules")}
        description={t("logic.rulesDetail")}
        actions={
          <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
            {t("logic.add")}
          </Button>
        }
      >
        {rules.length ? (
          <ol aria-label={t("logic.rules")} className="forms-list flex flex-col gap-1.5">
            {rules.map((r) => (
              <li key={`${r.page}:${r.field?.id ?? "page"}`} className="rounded-md border border-line px-2.5 py-1.5 text-sm text-fg">
                {r.field
                  ? t("logic.showField", { field: r.field.label || r.field.id, when: describe(t, r.cond, pages) })
                  : t("logic.showPage", { page: pages[r.page]?.title || t("form.pageN", { n: r.page + 1 }), when: describe(t, r.cond, pages) })}
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-sm text-fg-muted">{t("logic.none")}</p>
        )}
      </Panel>
      <div className="flex flex-col gap-2.5">
        {ownerBy && (
          <Panel title={t("logic.ownerBy", { field: all.find((f) => f.id === ownerBy.field)?.label ?? ownerBy.field })} description={t("logic.ownerByDetail")}>
            <dl className="forms-facts grid gap-x-2 gap-y-1.5 text-xs">
              {Object.entries(ownerBy.owners).map(([answer, email]) => (
                <div key={answer} className="contents">
                  <dt className="text-fg-muted">{answer}</dt>
                  <dd className="m-0 flex items-center gap-1.5 text-fg">
                    <Avatar name={email} size="sm" className="size-5" />
                    {email}
                  </dd>
                </div>
              ))}
              {detail?.sendTo.crm?.owner && (
                <div className="contents">
                  <dt className="text-fg-muted">{t("logic.otherwise")}</dt>
                  <dd className="m-0 text-fg">{detail.sendTo.crm.owner}</dd>
                </div>
              )}
            </dl>
          </Panel>
        )}
        <Callout tone="info" title={t("logic.short")}>
          {t("logic.shortDetail")}
        </Callout>
      </div>
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title={t("logic.add")}
        onSubmit={(e) => {
          e.preventDefault();
          if (!target || !source) return;
          setRule(draft, target.page, target.index, source.id, is.length ? is : [values[0]!]);
          onChange();
          setAdding(false);
        }}
        footer={
          <>
            <Button type="button" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!target || !source}>
              {t("logic.addButton")}
            </Button>
          </>
        }
      >
        <SelectField
          label={t("logic.show")}
          value={show}
          onChange={(e) => (setShow(e.target.value), setWhen(""), setIs([]))}
          options={targets.map((f) => ({ value: f.id, label: f.label || f.id }))}
        />
        {earlier.length ? (
          <>
            <SelectField
              label={t("logic.when")}
              value={source?.id ?? ""}
              onChange={(e) => (setWhen(e.target.value), setIs([]))}
              options={earlier.map((f) => ({ value: f.id, label: f.label || f.id }))}
            />
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="mb-1 text-xs font-medium text-fg">{t("logic.isOneOf")}</legend>
              {values.map((v) => (
                <Checkbox key={v} label={v} checked={is.includes(v)} onChange={(e) => setIs(e.target.checked ? [...is, v] : is.filter((x) => x !== v))} />
              ))}
            </fieldset>
          </>
        ) : (
          <p className="m-0 text-sm text-fg-muted">{t("logic.noEarlier")}</p>
        )}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- share

type Mode = "inline" | "popup" | "page";

function ShareTab({ id, detail }: { id: string; detail: FormDetail | null }) {
  const t = useT();
  const origin = window.location.origin;
  const [mode, setMode] = useState<Mode>("inline");
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");
  const [campaign, setCampaign] = useState("");
  const [hide, setHide] = useState(true);
  const url = detail?.url ?? `${origin}/f/${id}`;
  const snippet =
    mode === "page"
      ? url
      : `<script src="${origin}/embed.js" async></script>\n<div data-openasy-form="${id}"${mode === "popup" ? ` data-mode="popup" data-button="${t("share.buttonExample")}"` : ""}></div>`;
  const emailField = detail?.person.email;
  const params = [
    email && emailField && `${emailField}=${encodeURIComponent(email)}`,
    campaign && `utm_campaign=${encodeURIComponent(campaign)}`,
    hide && email && emailField && `hide=${emailField}`,
  ].filter(Boolean);
  const prefilled = `${url}${params.length ? `?${params.join("&")}` : ""}`;
  return (
    <div className="forms-halves grid gap-2.5">
      <Panel aria-label={t("share.embed")} title={t("share.embed")} description={t("share.embedDetail")}>
        <div className="flex flex-col gap-2">
          <SegmentedControl
            label={t("share.shownAs")}
            value={mode}
            onChange={(m) => (setMode(m), setCopied(false))}
            options={[
              { value: "inline" as const, label: t("share.inline") },
              { value: "popup" as const, label: t("share.popup") },
              { value: "page" as const, label: t("share.page") },
            ]}
          />
          <Code label={t("share.code")}>{snippet}</Code>
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<Copy />} onClick={() => void copy(snippet).then(setCopied)}>
              {t("share.copy")}
            </Button>
            {copied && (
              <span role="status" className="text-xs text-success">
                {t("share.copied")}
              </span>
            )}
          </div>
          <p className="m-0 text-xs text-fg-muted">
            {mode === "page"
              ? t("share.pageDetail")
              : detail?.embed.origins.length
                ? t("share.origins", { origins: detail.embed.origins.join(", ") })
                : t("share.noOrigins", { id })}
          </p>
          <p className="m-0 text-xs text-fg-muted">{t("share.analytics", { id })}</p>
        </div>
      </Panel>
      <Panel aria-label={t("share.prefilled")} title={t("share.prefilled")} description={t("share.prefilledDetail")}>
        <div className="flex flex-col gap-2">
          {emailField && (
            <TextField
              label={t("share.email", { field: emailField })}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ayse@example.com"
            />
          )}
          <TextField
            label="utm_campaign"
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
            placeholder="autumn-2026"
            hint={t("share.campaignHint")}
          />
          {emailField && <Checkbox label={t("share.hide")} checked={hide} onChange={(e) => setHide(e.target.checked)} />}
          <code aria-label={t("share.link")} className="block rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs break-all text-fg">
            {prefilled}
          </code>
          {!!detail?.definition.hidden.length && (
            <p className="m-0 text-xs text-fg-muted">{t("share.hiddenList", { names: detail.definition.hidden.join(", ") })}</p>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- routing

function RoutingTab({ detail }: { detail: FormDetail | null }) {
  const t = useT();
  if (!detail)
    return (
      <Callout tone="info" title={t("routing.draft")}>
        {t("routing.draftDetail")}
      </Callout>
    );
  const s = detail.sendTo;
  const routes: Array<{ target: Target; name?: string; what: string }> = [
    ...(s.audience
      ? [{ target: "audience" as const, what: t("routing.audience", { traits: s.traits.map((x) => x.trait).join(", ") || t("routing.noTraits") }) }]
      : []),
    ...(s.crm
      ? [
          {
            target: "crm" as const,
            what: s.crm.ownerBy
              ? t("routing.crmBy", { field: s.crm.ownerBy.field })
              : s.crm.owner
                ? t("routing.crmOwner", { owner: s.crm.owner })
                : t("routing.crm"),
          },
        ]
      : []),
    ...s.consent
      .filter((c) => c.linked)
      .map((c) => ({
        target: "consent" as const,
        what: t("routing.consent", { purpose: c.purpose, channels: c.channels.join(", "), version: c.version ?? "?" }),
      })),
    ...(s.helpdesk ? [{ target: "helpdesk" as const, what: t("routing.helpdesk", { form: s.helpdesk.form }) }] : []),
    ...(s.notify.length ? [{ target: "mail" as const, what: t("routing.mail", { to: s.notify.join(", ") }) }] : []),
    ...s.webhooks.map((w) => ({ target: "webhook" as const, name: w, what: t("routing.webhook") })),
  ];
  const stats = (r: { target: Target; name?: string }) =>
    detail.destinations.find((d) => d.target === r.target && (r.target !== "webhook" || d.name === r.name));
  return (
    <div className="forms-side grid gap-2.5">
      <Panel aria-label={t("routing.title")} title={t("routing.title")} description={t("routing.detail")}>
        {routes.length ? (
          <ul aria-label={t("routing.destinations")} className="forms-list flex flex-col gap-1.5">
            {routes.map((r) => {
              const st = stats(r);
              return (
                <li key={`${r.target}:${r.name ?? ""}`} className="flex items-start justify-between gap-3 border-b border-subtle pb-1.5 text-sm last:border-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-fg">{targetName(t, r.target, r.name)}</span>
                    <span className="text-xs text-fg-muted">{r.what}</span>
                  </span>
                  {st?.failed ? (
                    <StatusBadge tone="danger">{t("routing.failed", { n: st.failed })}</StatusBadge>
                  ) : (
                    <StatusBadge tone="success">{t("routing.sent", { n: st?.sent ?? 0 })}</StatusBadge>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 text-sm text-fg-muted">{t("routing.none")}</p>
        )}
      </Panel>
      <div className="flex flex-col gap-2.5">
        <Panel title={t("routing.after")}>
          <ul className="forms-list flex flex-col gap-1 text-xs text-fg">
            <li>{t("routing.partials", { mode: t(`partials.${detail.partials}`) })}</li>
            {detail.closes && <li>{t("routing.closes", { at: new Date(detail.closes).toLocaleDateString() })}</li>}
            {detail.limit !== null && <li>{t("routing.limit", { n: detail.limit })}</li>}
          </ul>
        </Panel>
        <Panel title={t("routing.spam")} description={detail.spam.captcha ? t("routing.captcha", { provider: detail.spam.captcha }) : t("routing.noCaptcha")}>
          <ul aria-label={t("routing.spamChecks")} className="forms-list flex flex-col gap-1 text-xs text-fg">
            <li>{t("routing.honeypot")}</li>
            <li>{t("routing.fast", { s: detail.spam.minSeconds })}</li>
            <li>{t("routing.rate", { rate: detail.spam.rate })}</li>
            {detail.spam.proofOfWork !== null && <li>{t("routing.pow", { bits: detail.spam.proofOfWork })}</li>}
          </ul>
          <p className="mt-1.5 mb-0 text-2xs text-fg-muted">{t("routing.held", { n: detail.week.spam })}</p>
        </Panel>
      </div>
    </div>
  );
}
