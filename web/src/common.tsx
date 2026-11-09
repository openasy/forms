// What the pages share: data loading with the session, formatting, and small pieces of layout.
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Target } from "./api.ts";
import type { T } from "./i18n.ts";
import { viewerLocale } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1)] as const;
}

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`my-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "danger" ? "bg-danger-soft" : "bg-success-soft"}`}
    >
      {children}
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre tabIndex={0} aria-label={label} className="forms-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

export const fmt = (n: number, locale: string = viewerLocale()) => n.toLocaleString(locale);
export const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
export const when = (iso: string, locale: string = viewerLocale()) =>
  new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const host = (url: string) => URL.parse(url)?.host ?? url;
export const seconds = (s: number | null) => (s === null ? "–" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`);

/** Copies text, and says so. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A destination's name as people read it. */
export function targetName(t: T, target: Target, name?: string | null) {
  return target === "webhook" ? t("dest.webhookNamed", { name: name ?? "" }) : t(`dest.${target}`);
}
