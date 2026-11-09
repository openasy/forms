// Results: how far people get in a form, what they answer, and NPS over time.
import {
  Badge,
  BarList,
  Callout,
  DonutChart,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  SelectField,
  TimeSeriesChart,
  useLocalePreference,
} from "@openasy/ui";
import { useState } from "react";
import type { FormSummary, Question, Report } from "./api.ts";
import { fmt, pct, seconds, useLoad, type Call } from "./common.tsx";
import { useT, viewerLocale } from "./i18n.ts";

const monthLabel = (m: string, locale: string = viewerLocale()) =>
  new Date(`${m}-15T12:00:00Z`).toLocaleDateString(locale, { month: "short", timeZone: "UTC" });

function QuestionPanel({ q }: { q: Question }) {
  const t = useT();
  if (q.options?.length)
    return (
      <Panel title={q.label} description={q.type === "choices" ? t("results.many") : t("results.answersN", { n: q.answers })}>
        <BarList label={t("results.answersTo", { q: q.label })} items={q.options.map((o) => ({ id: o.value, label: o.label, value: o.count }))} />
      </Panel>
    );
  if (q.scale?.length && q.type !== "nps")
    return (
      <Panel title={q.label} description={t("results.average", { n: q.average ?? "–" })}>
        <BarList label={t("results.answersTo", { q: q.label })} items={q.scale.map((s) => ({ id: String(s.value), label: String(s.value), value: s.count }))} />
      </Panel>
    );
  return null;
}

export function ResultsPage({ call, forms, form }: { call: Call; forms: FormSummary[]; form: string | null }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const current = form ?? forms[0]?.id ?? null;
  const summary = forms.find((f) => f.id === current);
  const [now] = useState(() => Date.now());
  const since = new Date(now - (summary?.kind === "nps" ? 365 : 7) * 86_400_000).toISOString().slice(0, 10);
  const [r] = useLoad<Report>(call, current ? `/api/v1/forms/${encodeURIComponent(current)}/report?from=${since}` : null);
  if (!current) return <EmptyState title={t("answers.noForms")}>{t("answers.noFormsDetail")}</EmptyState>;
  const header = (
    <PageHeader
      title={t("results.title")}
      description={t("results.description")}
      actions={
        <SelectField
          aria-label={t("answers.form")}
          value={current}
          onChange={(e) => navigate(`/results/${encodeURIComponent(e.target.value)}`)}
          options={forms.map((f) => ({ value: f.id, label: f.name }))}
          className="w-56"
        />
      }
    />
  );
  if (r === undefined) return header;
  if (r === null)
    return (
      <>
        {header}
        <EmptyState title={t("common.failed")} />
      </>
    );

  if (r.nps) {
    const months = r.npsMonths.slice(-12);
    const last = months.at(-1);
    const before = months.at(-2);
    return (
      <>
        {header}
        <KpiGrid minWidth={160} className="my-2.5">
          <KpiCard
            label={t("results.npsMonth", { month: last ? monthLabel(last.month, locale) : "–" })}
            value={last ? String(last.score) : "–"}
            delta={
              last && before
                ? {
                    label: t("results.onMonth", {
                      n: (last.score - before.score >= 0 ? "+" : "") + (last.score - before.score),
                      month: monthLabel(before.month, locale),
                    }),
                    direction: last.score >= before.score ? "up" : "down",
                    intent: last.score >= before.score ? "good" : "bad",
                  }
                : undefined
            }
          />
          <KpiCard label={t("results.answersYear")} value={fmt(r.submitted, locale)} />
          <KpiCard
            label={t("results.ofViews")}
            value={pct(r.submitted, r.views)}
            delta={{ label: t("results.viewsN", { n: fmt(r.views, locale) }), intent: "neutral" }}
          />
        </KpiGrid>
        <div className="forms-side mb-2.5 grid gap-2.5">
          <Panel title={t("results.npsTime")} description={t("results.npsTimeDetail")}>
            {months.length ? (
              <TimeSeriesChart
                label={t("results.npsByMonth")}
                labels={months.map((m) => monthLabel(m.month, locale))}
                series={[{ id: "nps", name: "NPS", data: months.map((m) => m.score) }]}
                yMax={100}
                xTicks={6}
                height={200}
              />
            ) : (
              <p className="m-0 text-sm text-fg-muted">{t("results.noAnswers")}</p>
            )}
          </Panel>
          <Panel title={t("results.scores")}>
            <DonutChart
              label={t("results.scoresLabel")}
              caption={t("results.answersCaption")}
              slices={[
                { id: "pro", name: t("results.promoters"), value: r.nps.promoters, color: "var(--oa-success)" },
                { id: "pas", name: t("results.passives"), value: r.nps.passives },
                { id: "det", name: t("results.detractors"), value: r.nps.detractors, color: "var(--oa-danger)" },
              ]}
            />
          </Panel>
        </div>
        <Panel title={t("results.reasons")} description={t("results.reasonsDetail")}>
          {r.reasons.length ? (
            <ul aria-label={t("results.reasons")} className="forms-list flex flex-col gap-2">
              {r.reasons.map((x) => (
                <li key={x.response} className="flex items-start gap-2 text-sm">
                  <Badge tone={x.score === null ? "neutral" : x.score >= 9 ? "success" : x.score >= 7 ? "neutral" : "danger"} mono>
                    {x.score ?? "–"}
                  </Badge>
                  <span className="flex flex-col">
                    <span className="text-fg">{x.text}</span>
                    <span className="text-2xs text-fg-muted">{x.name ?? t("answers.someone")}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("results.noReasons")}</p>
          )}
        </Panel>
      </>
    );
  }

  // Where people stop: everyone who reached each field, then the answers sent.
  const reached = [
    ...r.fields.map((f, i) => ({
      id: f.field,
      label: i > 0 && r.fields[i - 1]!.page !== f.page ? t("results.pageField", { n: f.page + 1, label: f.label }) : f.label,
      value: f.reached,
      color: i > 0 && r.fields[i - 1]!.page !== f.page ? "var(--oa-warning)" : undefined,
    })),
    { id: "sent", label: t("results.sentBar"), value: r.submitted, color: "var(--oa-success)" },
  ];
  // The page most people stopped on, of the answers not sent.
  const worst = r.pages.filter((p) => p.left > 0).sort((a, b) => b.left - a.left)[0];
  return (
    <>
      {header}
      <KpiGrid minWidth={160} className="my-2.5">
        <KpiCard label={t("results.views")} value={fmt(r.views, locale)} />
        <KpiCard
          label={t("results.started")}
          value={fmt(r.started, locale)}
          delta={{ label: t("results.ofViewsN", { p: pct(r.started, r.views) }), intent: "neutral" }}
        />
        <KpiCard
          label={t("results.sent")}
          value={fmt(r.submitted, locale)}
          delta={{ label: t("results.ofStarted", { p: pct(r.submitted, r.started) }), intent: "neutral" }}
        />
        <KpiCard label={t("results.time")} value={seconds(r.medianSeconds)} unit={t("results.median")} />
      </KpiGrid>
      <div className="forms-halves grid gap-2.5">
        <Panel title={t("results.stop")} description={t("results.stopDetail")}>
          <BarList label={t("results.reached")} items={reached} />
          {worst && (
            <Callout
              tone="warning"
              title={t("results.leave", { n: worst.left, of: r.started, page: worst.title ?? t("form.pageN", { n: worst.page + 1 }) })}
              className="mt-2"
            >
              {t("results.leaveDetail")}
            </Callout>
          )}
        </Panel>
        <div className="flex flex-col gap-2.5">
          {r.questions.map((q) => (
            <QuestionPanel key={q.field} q={q} />
          ))}
          {r.sources.length > 0 && (
            <Panel title={t("results.sources")} description={t("results.sourcesDetail")}>
              <BarList
                label={t("results.bySource")}
                items={r.sources.map((s) => ({ id: s.value, label: s.value === "none" ? t("answers.direct") : s.value, value: s.count }))}
              />
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
