// Integrations and Settings: the linked products as the file names them, and the file itself, read-only.
import { Callout, PageHeader, Panel, StatusBadge, useLocalePreference } from "@openasy/ui";
import type { Integrations, Settings } from "./api.ts";
import { Code, targetName, useLoad, when, type Call } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";

const EXAMPLES: Record<string, string> = {
  consent: "consent: { url: http://consent:8080, token: FORMS_CONSENT_TOKEN }",
  audience: "audience: { url: http://audience:8080, token: FORMS_AUDIENCE_TOKEN }",
  crm: "crm: { url: http://crm:8080, token: FORMS_CRM_TOKEN }",
  helpdesk: "helpdesk: { url: http://helpdesk:8080, key: FORMS_HELPDESK_KEY }",
  mail: "mail: { host: smtp.example.com, from: Forms <forms@example.com>, user: forms@example.com }",
};

export function IntegrationsPage({ call }: { call: Call }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [i] = useLoad<Integrations>(call, "/api/v1/integrations");
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="forms-halves grid gap-2.5">
        {(i?.links ?? []).map((l) => (
          <Panel
            key={l.id}
            title={targetName(t, l.id)}
            description={t(`integrations.${l.id as "consent" | "audience" | "crm" | "helpdesk" | "mail"}`)}
            actions={
              <StatusBadge tone={!l.linked ? "neutral" : !l.secretSet || l.failed ? "danger" : "success"}>
                {!l.linked
                  ? t("integrations.notLinked")
                  : !l.secretSet
                    ? t("integrations.secretUnset")
                    : l.failed
                      ? t("integrations.failedN", { n: l.failed })
                      : t("integrations.linked")}
              </StatusBadge>
            }
          >
            {l.linked ? (
              <div className="flex flex-col gap-1 text-xs text-fg-muted">
                <span>{t("integrations.at", { url: l.url ?? "" })}</span>
                {l.secret && <span>{l.secretSet ? t("integrations.secretSet", { name: l.secret }) : t("integrations.secretMissing", { name: l.secret })}</span>}
                <span>
                  {l.lastSentAt ? t("integrations.lastSent", { when: when(l.lastSentAt, locale), waiting: l.waiting }) : t("integrations.nothingYet")}
                </span>
                {l.purposes && l.purposes.length > 0 && (
                  <span>{t("integrations.purposes", { list: l.purposes.map((p) => `${p.id} v${p.version}`).join(", ") })}</span>
                )}
                {(l.error ?? l.lastError) && <span className="text-danger-text">{l.error ?? l.lastError}</span>}
              </div>
            ) : (
              <Code label={targetName(t, l.id)}>{EXAMPLES[l.id] ?? ""}</Code>
            )}
          </Panel>
        ))}
        <Panel title={t("integrations.webhooks")} description={t("integrations.webhooksDetail")}>
          {i?.webhooks.length ? (
            <ul className="forms-list flex flex-col gap-1 text-xs">
              {i.webhooks.map((w) => (
                <li key={w.id} className="flex flex-col">
                  <span className="font-medium text-fg">{w.id}</span>
                  <span className="break-all text-fg-muted">{w.url}</span>
                  {!w.secretSet && <span className="text-danger-text">{t("integrations.secretMissing", { name: w.secret })}</span>}
                  {w.lastError && <span className="text-danger-text">{w.lastError}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <Code label={t("integrations.webhooks")}>{`webhooks:\n  zapier: { url: https://hooks.example.com/forms, secret: FORMS_WEBHOOK_SECRET }`}</Code>
          )}
        </Panel>
        <Panel title={t("integrations.analytics")} description={t("integrations.analyticsDetail")}>
          {i?.analytics ? (
            <p className="m-0 text-xs text-fg-muted">{t("integrations.analyticsOn", { url: i.analytics })}</p>
          ) : (
            <Code label={t("integrations.analytics")}>analytics: https://analytics.example.com/s/forms.js</Code>
          )}
        </Panel>
        <Panel title={t("integrations.audienceErasure")} description={t("integrations.audienceErasureDetail")}>
          <Code label={t("integrations.audienceErasure")}>{`POST ${origin}/api/v1/erasures
Authorization: Bearer <a Forms token with the admin role>

{ "reference": "KVKK-2026-031", "product": "audience",
  "people": { "emails": ["…"], "phones": ["…"], "userIds": ["…"] } }

200 { "status": "done", "deleted": 2 }`}</Code>
        </Panel>
        <Panel title={t("integrations.api")} description={t("integrations.apiDetail")}>
          <Code label={t("integrations.api")}>{`curl ${origin}/api/v1/public/forms/<form>       # the form and a token
curl -X POST ${origin}/api/v1/public/forms/<form>/responses \\
  -H "content-type: application/json" \\
  -d '{"token":"…","answers":{"email":"ada@example.com"}}'`}</Code>
          <a href="/api/docs/" className="mt-2 inline-block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
      </div>
    </>
  );
}

export function SettingsFilePage({ settings }: { settings: Settings & { config: NonNullable<Settings["config"]> } }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const c = settings.config;
  const f = settings.file;
  const applied = f?.appliedAt ? when(f.appliedAt, locale) : t("settings.notYet");
  const days = (n: number) => t("settings.days", { n });
  return (
    <FileSettingsPage
      file="forms.yaml"
      applied={applied}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        <>
          {f?.error && (
            <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
              {f.error}
            </Callout>
          )}
          {!!f?.warnings.length && (
            <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
              <ul className="forms-list">
                {f.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      }
      groups={[
        {
          title: t("settings.answers"),
          description: t("settings.answersDetail"),
          items: [
            { label: t("settings.keptFor"), value: c.keep.responseDays === null ? t("settings.forever") : days(c.keep.responseDays), path: "keep.responses" },
            { label: t("settings.partials"), value: t("settings.partialsValue", { days: c.keep.partialDays }), path: "keep.partials" },
            { label: t("settings.spamKept"), value: days(c.keep.spamDays), path: "keep.spam" },
            { label: t("settings.language"), value: `${c.language}, ${c.timeZone}`, path: "language" },
          ],
        },
        {
          title: t("settings.forms"),
          description: t("settings.formsDetail"),
          items: c.forms.map((x) => ({
            label: x.name,
            value: t("settings.formValue", { kind: t(`kind.${x.kind}`), s: x.spam.minSeconds, rate: x.spam.rate, partials: t(`partials.${x.partials}`) }),
            path: `forms.${x.id}`,
          })),
        },
        {
          title: t("settings.spam"),
          description: c.captcha ? t("settings.captchaOn", { provider: c.captcha.provider }) : t("settings.noCaptcha"),
          items: [
            { label: t("settings.hiddenField"), value: "website", path: "spam" },
            { label: t("settings.captcha"), value: c.captcha ? `${c.captcha.provider}, ${c.captcha.siteKey}` : t("settings.none"), path: "captcha" },
          ],
        },
        {
          title: t("settings.links"),
          items: [
            { label: "Consent", value: c.consent?.url ?? t("settings.notLinked"), path: "consent" },
            { label: "Audience", value: c.audience?.url ?? t("settings.notLinked"), path: "audience" },
            { label: "CRM", value: c.crm?.url ?? t("settings.notLinked"), path: "crm" },
            { label: "Helpdesk", value: c.helpdesk?.url ?? t("settings.notLinked"), path: "helpdesk" },
            { label: "Analytics", value: c.analytics ?? t("settings.notLinked"), path: "analytics" },
            { label: t("settings.mail"), value: c.mail ? `${c.mail.host}:${c.mail.port}, ${c.mail.from}` : t("settings.none"), path: "mail" },
            { label: t("settings.webhooks"), value: c.webhooks.map((w) => w.id).join(", ") || t("settings.none"), path: "webhooks" },
          ],
        },
        {
          title: t("settings.roles"),
          items: [{ label: t("settings.rolesLabel"), value: t("settings.rolesValue"), path: "Members" }],
        },
      ]}
    />
  );
}
