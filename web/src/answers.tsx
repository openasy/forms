// Answers: one form's answers, where each went, the partial answers people left, and what was held as spam.
import {
  Avatar,
  Button,
  DataTable,
  EmptyState,
  FacetFilter,
  FilterBar,
  PageHeader,
  Panel,
  SearchInput,
  SelectField,
  StatusBadge,
  Tabs,
  navigate,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { FileDown, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Delivery, FormDetail, FormSummary, ResponseDetail, ResponseList, ResponseSummary } from "./api.ts";
import { fmt, Notice, targetName, useLoad, when, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

type Tab = "submitted" | "partial" | "spam";

/** What a destination did with the answer, as people read it. */
function went(t: T, d: Delivery): string {
  const r = d.result ?? {};
  if (d.state === "failed") return t("went.failed", { error: d.error ?? "" });
  if (d.state === "waiting") return d.error ? t("went.retrying", { error: d.error, n: d.attempts }) : t("went.waiting");
  switch (d.target) {
    case "crm":
      return t("went.crm", { url: String(r.url ?? "") });
    case "helpdesk":
      return t("went.helpdesk", { ref: String(r.reference ?? r.number ?? "") });
    case "audience":
      return t("went.audience");
    case "consent":
      return t("went.consent");
    case "mail":
      return t("went.mail");
    case "webhook":
      return t("went.webhook", { status: String(r.status ?? "") });
  }
}

const tone = (s: string) => (s === "sent" ? "success" : s === "failed" ? "danger" : "warning");

function AnswerPanel({ call, id, detail, onChanged }: { call: Call; id: string; detail: FormDetail | undefined; onChanged: (msg: string) => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [r, reload] = useLoad<ResponseDetail>(call, `/api/v1/responses/${encodeURIComponent(id)}`);
  const [busy, setBusy] = useState(false);
  if (r === undefined) return <Panel title={t("loading")} />;
  if (r === null) return <Panel title={t("common.failed")} />;
  const act = async (path: string, msg: string, method = "POST") => {
    setBusy(true);
    try {
      await call(`/api/v1/responses/${encodeURIComponent(r.id)}${path}`, { method });
      onChanged(msg);
      if (method !== "DELETE") reload();
    } finally {
      setBusy(false);
    }
  };
  const boxes = (r.answers ?? []).filter((a) => a.type === "consent");
  const consentFields = detail?.sendTo.consent ?? [];
  const failed = r.deliveries.filter((d) => d.state === "failed");
  const title = [r.person.name ?? r.person.email ?? t("answers.someone"), r.person.company].filter(Boolean).join(", ");
  return (
    <Panel
      aria-label={t("answers.answer")}
      title={title}
      description={`${when(r.submittedAt ?? r.updatedAt, locale)}${r.meta.url ? ` ${t("answers.on", { page: new URL(r.meta.url).pathname })}` : ""}`}
    >
      <div className="flex flex-col gap-3 text-xs">
        <dl className="forms-facts grid gap-x-2 gap-y-1">
          {(r.answers ?? [])
            .filter((a) => a.type !== "consent")
            .map((a) => (
              <div key={a.field} className="contents">
                <dt className="text-fg-muted">{a.label}</dt>
                <dd className="m-0 min-w-0 break-words whitespace-pre-wrap text-fg">
                  {a.file ? (
                    <a href={`/api/v1/files/${encodeURIComponent(a.file.id)}`} target="_blank" rel="noopener">
                      {a.file.name}
                    </a>
                  ) : (
                    a.text || "–"
                  )}
                </dd>
              </div>
            ))}
          {Object.keys(r.hidden).length > 0 && (
            <>
              <dt className="text-fg-muted">{t("answers.hidden")}</dt>
              <dd className="m-0 font-mono text-2xs text-fg">
                {Object.entries(r.hidden)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")}
              </dd>
            </>
          )}
          {r.meta.utm && (
            <>
              <dt className="text-fg-muted">{t("answers.campaign")}</dt>
              <dd className="m-0 font-mono text-2xs text-fg">{[r.meta.utm.source, r.meta.utm.medium, r.meta.utm.campaign].filter(Boolean).join(" / ")}</dd>
            </>
          )}
          {r.answers === null && (
            <>
              <dt className="text-fg-muted">{t("answers.answered")}</dt>
              <dd className="m-0 text-fg">{r.answeredFields.join(", ") || "–"}</dd>
            </>
          )}
        </dl>
        {consentFields.length > 0 && r.answers && (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-fg">{t("answers.consentBox")}</span>
            {boxes.length ? (
              boxes.map((b) => {
                const c = consentFields.find((x) => x.field === b.field);
                return (
                  <span key={b.field} className="text-fg">
                    {t("answers.ticked", { version: c?.version ?? "?", purpose: c?.purpose ?? b.label })} <q className="text-fg-muted">{b.label}</q>
                  </span>
                );
              })
            ) : (
              <span className="text-fg-muted">{t("answers.notTicked")}</span>
            )}
          </div>
        )}
        {r.status === "submitted" && (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-fg">{t("answers.went")}</span>
            {r.deliveries.length ? (
              <ul aria-label={t("answers.went")} className="forms-list flex flex-col gap-1">
                {r.deliveries.map((d) => (
                  <li key={d.id} className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-fg">{targetName(t, d.target, d.name)}</span>
                      <span className="text-2xs break-words text-fg-muted">{went(t, d)}</span>
                    </span>
                    <StatusBadge tone={tone(d.state)}>{t(`delivery.${d.state}`)}</StatusBadge>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-fg-muted">{t("answers.keptHere")}</span>
            )}
            {failed.length > 0 && (
              <div>
                <Button
                  size="sm"
                  icon={<RotateCw />}
                  loading={busy}
                  onClick={() => void act("/retry", t("answers.resent", { to: failed.map((d) => targetName(t, d.target, d.name)).join(", ") }))}
                >
                  {failed.length === 1 ? t("answers.resendTo", { to: targetName(t, failed[0]!.target, failed[0]!.name) }) : t("answers.resend")}
                </Button>
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {r.status === "submitted" && (
            <Button size="sm" onClick={() => void act("/spam", t("answers.markedSpam"))} disabled={busy}>
              {t("answers.markSpam")}
            </Button>
          )}
          <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => void act("", t("answers.deleted"), "DELETE")} disabled={busy}>
            {t("answers.delete")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export function AnswersPage({ call, forms, form, open }: { call: Call; forms: FormSummary[]; form: string | null; open?: string }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const current = form ?? forms[0]?.id ?? null;
  const [tab, setTab] = useState<Tab>("submitted");
  const [query, setQuery] = useState("");
  const [consent, setConsent] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [active, setActive] = useState<string | undefined>(open);
  const [notice, setNotice] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => setActive(open), [open]);
  const params = new URLSearchParams({ status: tab, limit: "200" });
  if (query.trim()) params.set("q", query.trim());
  if (consent.length === 1) params.set("consent", consent[0]!);
  if (sources.length === 1) params.set("source", sources[0]!);
  const [list] = useLoad<ResponseList>(call, current ? `/api/v1/forms/${encodeURIComponent(current)}/responses?${params}&n=${n}` : null);
  const [detail] = useLoad<FormDetail>(call, current ? `/api/v1/forms/${encodeURIComponent(current)}` : null);
  const summary = forms.find((f) => f.id === current);
  const rows = list?.responses ?? [];
  const cur = rows.find((r) => r.id === active) ?? rows[0];
  const changed = (msg: string) => {
    setNotice(msg);
    setN((x) => x + 1);
  };
  if (!current) return <EmptyState title={t("answers.noForms")}>{t("answers.noFormsDetail")}</EmptyState>;
  const exportHref = `/api/v1/forms/${encodeURIComponent(current)}/export?${new URLSearchParams([...params].filter(([k]) => k !== "limit"))}`;
  const person = (r: ResponseSummary) => r.person.name ?? r.person.email ?? t("answers.someone");
  const cols: Column<ResponseSummary>[] = [
    {
      id: "name",
      header: t("answers.person"),
      width: "30%",
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={person(r)} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{person(r)}</span>
            <span className="truncate text-2xs text-fg-muted">{r.person.company ?? r.person.email ?? ""}</span>
          </span>
        </span>
      ),
    },
    {
      id: "at",
      header: t("answers.sent"),
      sortValue: (r) => r.submittedAt ?? "",
      cell: (r) => <span className="text-xs whitespace-nowrap">{when(r.submittedAt ?? r.updatedAt, locale)}</span>,
    },
    {
      id: "first",
      header: t("answers.preview"),
      cell: (r) => (
        <span className="block max-w-64 truncate text-xs">
          {r.preview
            .filter((p) => !["name", "email", "company"].includes(p.field))
            .map((p) => p.text)
            .join(" · ") || "–"}
        </span>
      ),
    },
    ...(summary?.kind === "nps"
      ? [
          {
            id: "nps",
            header: "NPS",
            align: "right" as const,
            mono: true,
            sortValue: (r: ResponseSummary) => r.nps ?? -1,
            cell: (r: ResponseSummary) => r.nps ?? "–",
          },
        ]
      : []),
    {
      id: "went",
      header: t("answers.wentTo"),
      cell: (r) =>
        !r.deliveries.length ? (
          <span className="text-xs text-fg-muted">{t("answers.keptShort")}</span>
        ) : r.deliveries.some((d) => d.state === "failed") ? (
          <StatusBadge tone="danger">{t("answers.failedN", { n: r.deliveries.filter((d) => d.state === "failed").length })}</StatusBadge>
        ) : r.deliveries.some((d) => d.state === "waiting") ? (
          <StatusBadge tone="warning">{t("answers.waitingN", { n: r.deliveries.filter((d) => d.state === "waiting").length })}</StatusBadge>
        ) : (
          <StatusBadge tone="success">{t("answers.allN", { n: r.deliveries.length })}</StatusBadge>
        ),
    },
  ];
  const facets = list?.facets;
  return (
    <>
      <PageHeader
        title={t("answers.title")}
        description={t("answers.description")}
        actions={
          <>
            <SelectField
              aria-label={t("answers.form")}
              value={current}
              onChange={(e) => navigate(`/answers/${encodeURIComponent(e.target.value)}`)}
              options={forms.map((f) => ({ value: f.id, label: f.name }))}
              className="w-56"
            />
            <Button icon={<FileDown />} onClick={() => (window.location.href = exportHref)}>
              {t("answers.export")}
            </Button>
          </>
        }
      >
        <Tabs
          label={t("answers.title")}
          value={tab}
          onChange={(x) => (setTab(x), setActive(undefined))}
          items={[
            { value: "submitted", label: t("answers.complete"), count: tab === "submitted" ? list?.total : undefined },
            { value: "partial", label: t("answers.partial"), count: tab === "partial" ? list?.total : summary?.week.partial },
            { value: "spam", label: t("answers.spam"), count: tab === "spam" ? list?.total : summary?.week.spam },
          ]}
        />
      </PageHeader>
      {notice && <Notice>{notice}</Notice>}
      <div className="mt-2.5">
        {tab === "submitted" && (
          <div className="forms-side-wide grid gap-2.5">
            <Panel flush aria-label={t("answers.all")}>
              <div className="px-3 py-2">
                <FilterBar onClear={consent.length || sources.length || query ? () => (setConsent([]), setSources([]), setQuery("")) : undefined}>
                  <SearchInput
                    label={t("answers.search")}
                    placeholder={t("answers.searchPlaceholder")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-56"
                  />
                  {facets?.consent && (
                    <FacetFilter
                      label={t("answers.consent")}
                      options={[
                        { value: "yes", label: t("answers.tickedShort"), count: facets.consent.yes },
                        { value: "no", label: t("answers.notTickedShort"), count: facets.consent.no },
                      ]}
                      selected={consent}
                      onChange={(v) => setConsent(v.slice(-1))}
                    />
                  )}
                  {!!facets?.sources.length && (
                    <FacetFilter
                      label={t("answers.source")}
                      options={facets.sources.map((s) => ({ value: s.value, label: s.value === "none" ? t("answers.direct") : s.value, count: s.count }))}
                      selected={sources}
                      onChange={(v) => setSources(v.slice(-1))}
                    />
                  )}
                </FilterBar>
              </div>
              <div className="border-t border-line">
                <DataTable
                  label={t("answers.title")}
                  columns={cols}
                  rows={rows}
                  getRowId={(r) => r.id}
                  onRowClick={(r) => setActive(r.id)}
                  activeRowId={cur?.id}
                  minWidth={720}
                  loading={list === undefined}
                  empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("answers.none")}</p>}
                />
              </div>
              {list && list.total > rows.length && (
                <p className="px-3 py-2 text-xs text-fg-muted">{t("answers.more", { n: fmt(list.total - rows.length, locale) })}</p>
              )}
            </Panel>
            {cur && <AnswerPanel key={`${cur.id}:${n}`} call={call} id={cur.id} detail={detail ?? undefined} onChanged={changed} />}
          </div>
        )}
        {tab === "partial" && (
          <Panel flush title={t("answers.partialTitle")} description={summary && detail ? t(`answers.partialDetail.${detail.partials}`) : undefined}>
            <DataTable
              label={t("answers.partialTitle")}
              rows={list?.responses ?? []}
              getRowId={(p) => p.id}
              minWidth={560}
              loading={list === undefined}
              empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("answers.noPartial")}</p>}
              columns={[
                { id: "at", header: t("answers.started"), cell: (p) => <span className="text-xs">{when(p.startedAt, locale)}</span> },
                { id: "email", header: t("answers.email"), cell: (p) => <span className="font-mono text-xs">{p.person.email ?? t("answers.notKept")}</span> },
                {
                  id: "reached",
                  header: t("answers.stoppedAt"),
                  cell: (p) => detail?.definition.pages[p.page]?.title ?? t("answers.pageOf", { n: p.page + 1, of: p.pages }),
                },
                {
                  id: "of",
                  header: t("answers.answeredN"),
                  cell: (p) => <span className="text-xs text-fg-muted">{t("answers.ofFields", { n: p.answered, of: summary?.fields ?? "?" })}</span>,
                },
              ]}
            />
          </Panel>
        )}
        {tab === "spam" && (
          <Panel flush title={t("answers.spamTitle")} description={t("answers.spamDetail")}>
            <DataTable
              label={t("answers.spam")}
              rows={list?.responses ?? []}
              getRowId={(s) => s.id}
              minWidth={640}
              loading={list === undefined}
              empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("answers.noSpam")}</p>}
              columns={[
                { id: "at", header: t("answers.sent"), cell: (s) => <span className="text-xs">{when(s.submittedAt ?? s.updatedAt, locale)}</span> },
                { id: "name", header: t("answers.nameGiven"), cell: (s) => s.person.name ?? s.person.email ?? "–" },
                { id: "why", header: t("answers.why"), cell: (s) => <span className="text-xs">{spamWhy(t, s.spamReason)}</span> },
                {
                  id: "act",
                  header: <span className="sr-only">{t("answers.actions")}</span>,
                  label: t("answers.actions"),
                  align: "right",
                  cell: (s) => (
                    <Button
                      size="xs"
                      onClick={() =>
                        void call(`/api/v1/responses/${encodeURIComponent(s.id)}/not-spam`, { method: "POST" }).then(() =>
                          changed(t("answers.notSpamDone", { name: s.person.name ?? s.person.email ?? t("answers.someone") })),
                        )
                      }
                    >
                      {t("answers.notSpam")}
                    </Button>
                  ),
                },
              ]}
            />
          </Panel>
        )}
      </div>
    </>
  );
}

function spamWhy(t: T, reason: string | null) {
  if (reason === "honeypot") return t("spamWhy.honeypot");
  if (reason === "too_fast") return t("spamWhy.tooFast");
  if (reason?.startsWith("marked by ")) return t("spamWhy.marked", { name: reason.slice(10) });
  return reason ?? "–";
}
