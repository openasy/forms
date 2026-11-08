import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { brandFromEnv, createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb, pageKey } from "./db.ts";
import { createForms } from "./forms.ts";
import { smtpMailer } from "./links.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.FORMS_DB ?? "/data/forms.db";
const configPath = process.env.FORMS_CONFIG?.trim() || "/config/forms.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const pageScript = new URL("../dist/page/f.js", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.FORMS_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.FORMS_METRICS_PORT ? Number(process.env.FORMS_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open Forms at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects, the form
// pages, the embed script and the links in notifications use it.
const publicUrl = (process.env.FORMS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.FORMS_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "forms",
  productName: "OpenAsy Forms",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.FORMS_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
let file: ReturnType<typeof watchConfig> | undefined;
const forms = createForms(db, {
  publicUrl,
  tokenKey: pageKey(db),
  fileState: () => file?.state ?? null,
  mailer: (c) => (c.mail ? smtpMailer(c.mail, c.mail.password ? process.env[c.mail.password] : undefined) : null),
});
// The forms come from the file and only from it; a file with a mistake keeps the last good one in place.
// Each form may be its own file in the forms folder next to forms.yaml (FORMS_DIR), one form per file.
const formsDir = process.env.FORMS_DIR?.trim() || undefined;
file = watchConfig(configPath, (config, text, files) => forms.setConfig(config, text, files), {
  dir: formsDir,
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, Forms starts with no forms, so a first look needs nothing written.
if (!forms.config()) {
  forms.setConfig(parseConfig(""), "");
  log("warn", "no settings file applied: using the defaults (no forms) until it can be read", { file: configPath });
}
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    forms,
    version,
    auth,
    publicUrl,
    accent: brandFromEnv(process.env).accent,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    pageScript: existsSync(pageScript) ? pageScript : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
    trustProxy: process.env.FORMS_TRUST_PROXY === "true",
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(forms, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "forms started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl))
  log("warn", "FORMS_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put it behind TLS (ADR 0026)", { url: publicUrl });
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => void forms.tick().catch((err: unknown) => log("error", "background work failed", { error: String(err) })), 15_000),
];
void forms.tick().catch(() => {});

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
