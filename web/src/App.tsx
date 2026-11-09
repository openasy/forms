import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  useLocalePreference,
  usePath,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import colophon from "virtual:openasy-colophon";
import { ChartColumn, ClipboardList, Inbox, KeyRound, LogIn, LogOut, Plug, Settings as SettingsIcon, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnswersPage } from "./answers.tsx";
import type { FormSummary, ProductLink, ResponseDetail, Settings, Summary } from "./api.ts";
import { useApi, type Call } from "./common.tsx";
import { FormPage, FormsPage } from "./forms.tsx";
import { useT, setViewerLocale } from "./i18n.ts";
import { IntegrationsPage, SettingsFilePage } from "./pages.tsx";
import { ResultsPage } from "./results.tsx";

const PAGES = ["forms", "answers", "results", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES, "responses"];

interface Route {
  page: Page | "response";
  a?: string;
  b?: string;
}
function parseRoute(path: string): Route {
  const [page, a, b] = path
    .replace(/^\//, "")
    .split("/")
    .map((x) => decodeURIComponent(x));
  if (page === "responses" && a) return { page: "response", a };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page, a, b };
  return { page: "forms" };
}

/** An answer's link from a notification email: opens it on the Answers page of its form. */
function ResponseLink({ call, id }: { call: Call; id: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void call<ResponseDetail>(`/api/v1/responses/${encodeURIComponent(id)}`).then(
      (r) => navigate(`/answers/${encodeURIComponent(r.form)}/${encodeURIComponent(r.id)}`, { replace: true }),
      () => setFailed(true),
    );
  }, [call, id]);
  return failed ? <EmptyState title={t("answers.gone")}>{t("answers.goneDetail")}</EmptyState> : <PageHeader title={t("loading")} />;
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [settings, setSettings] = useState<Settings>();
  const [forms, setForms] = useState<FormSummary[]>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "forms" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
    void call<{ forms: FormSummary[] }>("/api/v1/forms").then(
      (r) => setForms(r.forms),
      () => {},
    );
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds forms and answers by name, email or company.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const list = forms ?? [];
      const found = list.filter((f) => `${f.name} ${f.id}`.toLocaleLowerCase("tr").includes(q.toLocaleLowerCase("tr"))).slice(0, 5);
      const answers = await Promise.all(
        list.slice(0, 5).map((f) =>
          call<{ responses: Array<{ id: string; person: { name: string | null; email: string | null; company: string | null } }> }>(
            `/api/v1/forms/${encodeURIComponent(f.id)}/responses?${new URLSearchParams({ q, limit: "3" })}`,
            { signal },
          ).then(
            (r) => r.responses.map((x) => ({ ...x, form: f })),
            () => [],
          ),
        ),
      );
      return [
        ...found.map((f) => ({ id: `form:${f.id}`, label: f.name, detail: f.file, kind: msg("search.form"), icon: ClipboardList, href: `/forms/${f.id}` })),
        ...answers.flat().map((a) => ({
          id: `answer:${a.id}`,
          label: a.person.name ?? a.person.email ?? a.id,
          detail: `${a.form.name}${a.person.company ? ` · ${a.person.company}` : ""}`,
          kind: msg("search.answer"),
          icon: Inbox,
          href: `/answers/${a.form.id}/${a.id}`,
        })),
      ];
    },
    [call, forms, msg],
  );

  const nav = [
    { id: "forms", label: msg("nav.forms"), icon: ClipboardList },
    { id: "answers", label: msg("nav.answers"), icon: Inbox, count: summary?.failed || undefined },
    { id: "results", label: msg("nav.results"), icon: ChartColumn },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "response" ? "answers" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const ready = settings?.config ? (settings as Settings & { config: NonNullable<Settings["config"]> }) : undefined;
  const language = ready?.config.language ?? "en";

  return (
    <AppShell
      product="forms"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {summary?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {summary.file.error}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : route.page === "response" ? (
        <ResponseLink call={call} id={route.a!} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage call={call} />
      ) : !ready || !forms ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "settings" ? (
        <SettingsFilePage settings={ready} />
      ) : route.page === "answers" ? (
        <AnswersPage key={route.a ?? ""} call={call} forms={forms} form={route.a ?? null} open={route.b} />
      ) : route.page === "results" ? (
        <ResultsPage key={route.a ?? ""} call={call} forms={forms} form={route.a ?? null} />
      ) : route.a ? (
        <FormPage key={route.a} call={call} id={route.a} tab={new URLSearchParams(window.location.search).get("tab") ?? undefined} language={language} />
      ) : (
        <FormsPage call={call} language={language} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Forms">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
