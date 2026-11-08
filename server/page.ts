// The form's own page, /f/<id>: the form's title for people without JavaScript and for link previews, the form itself
// as JSON for the form script (/embed.js) to draw, and Analytics' script when the file names one. The same script
// draws the form on other sites from one script tag.
import type { Lang } from "./config.ts";
import type { PublicForm } from "./logic.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const NO_SCRIPT: Record<Lang, string> = {
  en: "This form needs JavaScript. Turn it on for this page, or write to us another way.",
  tr: "Bu form JavaScript gerektirir. Bu sayfa için açın ya da bize başka bir yoldan yazın.",
  de: "Dieses Formular braucht JavaScript. Schalten Sie es für diese Seite ein oder schreiben Sie uns auf anderem Weg.",
};
const PREVIEW: Record<Lang, string> = {
  en: "Preview: nothing sent here is kept.",
  tr: "Önizleme: burada gönderilen hiçbir şey saklanmaz.",
  de: "Vorschau: Was hier gesendet wird, wird nicht gespeichert.",
};

export function formPage(o: { form: PublicForm; lang: Lang; accent: string; analytics: string | null; preview: boolean; framed: boolean }) {
  const f = o.form;
  // JSON in a script element: < is escaped so nothing in the file can close it.
  const data = JSON.stringify(f).replace(/</g, "\\u003c");
  const accent = /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent : "#2f5bd3";
  return `<!doctype html>
<html lang="${o.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(f.title)}</title>
${f.description ? `<meta name="description" content="${esc(f.description.slice(0, 300))}">` : ""}
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<style>
:root { color-scheme: light dark; --oaf-accent: ${accent}; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f4f5f7; color: #16181d; }
@media (prefers-color-scheme: dark) { body { background: #111317; color: #e8eaed; } .oaf-card { background: #1a1d23 !important; border-color: #2c3038 !important; } }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px 48px; }
body.framed main { padding: 0; max-width: none; }
.oaf-card { background: #fff; border: 1px solid #e1e4e8; border-radius: 12px; padding: 28px 24px; }
body.framed .oaf-card { border: 0; border-radius: 0; background: transparent; }
.oaf-preview { font-size: 13px; padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; background: color-mix(in srgb, var(--oaf-accent) 14%, transparent); }
.oaf-static h1 { font-size: 24px; margin: 0 0 8px; }
</style>
${o.analytics ? `<script defer src="${esc(o.analytics)}"></script>` : ""}
</head>
<body${o.framed ? ' class="framed"' : ""}>
<main>
${o.preview ? `<p class="oaf-preview" role="status">${PREVIEW[o.lang]}</p>` : ""}
<div class="oaf-card">
<div data-openasy-form="${esc(f.id)}" data-lang="${o.lang}"${o.preview ? ' data-preview="1"' : ""}>
<div class="oaf-static"><h1>${esc(f.title)}</h1>${f.description ? `<p>${esc(f.description)}</p>` : ""}<noscript><p>${NO_SCRIPT[o.lang]}</p></noscript></div>
</div>
</div>
</main>
<script type="application/json" id="openasy-form-${esc(f.id)}">${data}</script>
<script src="/embed.js" async></script>
</body>
</html>
`;
}

export function missingPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Form not found</title><meta name="robots" content="noindex"></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px"><h1>Form not found</h1><p>There is no form at this address. Check the link you were sent.</p></body></html>
`;
}
