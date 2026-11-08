// Prometheus text exposition, written by hand: a few lines, no client library needed.
import type { Forms } from "./forms.ts";

const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

const label = (s: string) => s.replace(/["\\\n]/g, "_");

export function renderMetrics(version: string, g: ReturnType<Forms["gauges"]>, fileError: boolean): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="forms",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_forms_forms Forms in the settings file.",
    "# TYPE openasy_forms_forms gauge",
    `openasy_forms_forms ${g.forms}`,
    "# HELP openasy_forms_responses Answers kept, by status.",
    "# TYPE openasy_forms_responses gauge",
    ...["submitted", "partial", "spam"].map((s) => `openasy_forms_responses{status="${s}"} ${g.responses[s] ?? 0}`),
    "# HELP openasy_forms_responses_total Answers taken since the start, by form and result (submitted, spam, partial).",
    "# TYPE openasy_forms_responses_total counter",
    ...[...g.counters.responses].map(([k, n]) => {
      const [form, result] = k.split(":");
      return `openasy_forms_responses_total{form="${label(form!)}",result="${result}"} ${n}`;
    }),
    "# HELP openasy_forms_deliveries Answers waiting to be sent, or failed, by where they go.",
    "# TYPE openasy_forms_deliveries gauge",
    ...g.deliveries.map((d) => `openasy_forms_deliveries{target="${d.target}",state="${d.state}"} ${d.n}`),
    "# HELP openasy_forms_deliveries_total Sending to Consent, Audience, CRM, Helpdesk, mail and webhooks, by result.",
    "# TYPE openasy_forms_deliveries_total counter",
    ...[...g.counters.deliveries].map(([k, n]) => {
      const [target, result] = k.split(":");
      return `openasy_forms_deliveries_total{target="${target}",result="${result}"} ${n}`;
    }),
    "# HELP openasy_forms_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_forms_config_error gauge",
    `openasy_forms_config_error ${fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
