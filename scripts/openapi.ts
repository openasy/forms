// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties), extra?: boolean) => ({
  type: "object",
  required,
  properties,
  ...(extra === false && { additionalProperties: false }),
});
const map = { type: "object" };
const en = (...values: string[]) => ({ type: "string", enum: values });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const idParam = (what: string) => ({ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str });
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, `Needs the ${role} role.`].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const Value = { anyOf: [str, num, bool, arr(str)], description: "Text, a number, yes or no (true, false), the options ticked, or a file's id." };
const TARGET = en("consent", "audience", "crm", "helpdesk", "mail", "webhook");
const Condition = {
  description: "One test on an earlier answer; any holds when one of its own does.",
  anyOf: [
    obj(
      {
        field: str,
        is: { anyOf: [str, num, bool] },
        not: { anyOf: [str, num, bool] },
        in: arr(str),
        answered: bool,
        above: num,
        below: num,
      },
      ["field"],
    ),
    obj({ any: arr({ $ref: "#/components/schemas/Condition" }) }),
  ],
};
const FIELD_TYPE = en(
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
);
const PublicField = obj({
  id: str,
  type: FIELD_TYPE,
  label: { type: "string", description: "The question; for a consent box, the text of the purpose's version in Consent." },
  help: nul(str),
  placeholder: nul(str),
  required: bool,
  min: nul(num),
  max: nul(num),
  pattern: nul(str),
  patternMessage: nul(str),
  options: arr(obj({ value: str, label: str })),
  minLabel: nul(str),
  maxLabel: nul(str),
  accept: { ...arr(str), description: "File fields: the MIME types taken." },
  maxSize: nul(int),
  consent: nul(
    obj({
      purpose: str,
      channels: arr(str),
      version: { ...nul(int), description: "The version of the text shown, null until Forms has read it from Consent." },
    }),
  ),
  showIf: arr(ref("Condition")),
});
const PublicPage = obj({ title: nul(str), description: nul(str), showIf: arr(ref("Condition")), fields: arr(ref("PublicField")) });
const PublicForm = obj({
  id: str,
  name: str,
  kind: en("lead", "contact", "nps", "survey"),
  language: str,
  title: str,
  description: nul(str),
  pages: arr(ref("PublicPage")),
  hidden: { ...arr(str), description: "Answers filled from the page's address or the tag's data-value-<field> attributes." },
  submit: str,
  thanks: str,
  redirect: nul(str),
  closed: { anyOf: [en("closed", "full"), { type: "null" }] },
  closedText: nul(str),
  token: { type: "string", description: "Sent back with the answer: it times it, and one token makes one answer." },
  spam: obj({
    honeypot: { type: "string", description: "The name of the field people never see; send it empty." },
    proofOfWork: { ...nul(int), description: "Zero bits sha256(token:proof) must start with; null for none." },
    captcha: nul(obj({ provider: en("turnstile", "hcaptcha"), siteKey: str })),
  }),
  partials: en("off", "progress", "answers"),
  endpoint: str,
});
const Delivery = obj({
  id: int,
  target: TARGET,
  name: { ...nul(str), description: "The webhook's id." },
  state: en("waiting", "sent", "failed"),
  attempts: int,
  error: nul(str),
  result: { ...nul(map), description: "What the product answered: CRM's deal and its address, Helpdesk's ticket, Audience's profile, Consent's person." },
  nextAt: nul(dt),
  createdAt: dt,
  doneAt: nul(dt),
});
const Person = obj({ email: nul(str), phone: nul(str), name: nul(str), company: nul(str) });
const ResponseSummary = obj({
  id: str,
  form: str,
  status: en("partial", "submitted", "spam"),
  language: str,
  startedAt: dt,
  updatedAt: dt,
  submittedAt: nul(dt),
  page: { type: "integer", description: "The furthest page reached, from 0." },
  pages: int,
  person: Person,
  nps: nul(int),
  spamReason: { ...nul(str), description: "honeypot, too_fast, or who marked it." },
  answered: int,
  preview: arr(obj({ field: str, label: str, text: str })),
  hidden: { type: "object", additionalProperties: str },
  deliveries: arr(obj({ target: TARGET, name: nul(str), state: str })),
});
const AnswerItem = obj(
  {
    field: str,
    label: str,
    type: str,
    value: Value,
    text: { type: "string", description: "As people read it: option labels, Yes or No, the file's name." },
    file: obj({ id: str, name: str, size: int, type: str }),
  },
  ["field", "label", "type", "value", "text"],
);
const Route = obj({ target: TARGET, name: nul(str), sent: int, waiting: int, failed: int });
const Nps = nul(obj({ score: int, promoters: int, passives: int, detractors: int, answers: int }));
const FormSummary = obj({
  id: str,
  name: str,
  kind: en("lead", "contact", "nps", "survey"),
  title: str,
  state: en("open", "closed", "full"),
  closes: nul(dt),
  limit: nul(int),
  pages: int,
  fields: int,
  languages: arr(str),
  week: obj({
    views: { type: "integer", description: "Times the form was shown, in the last 7 days." },
    submitted: int,
    partial: int,
    leads: { type: "integer", description: "Answers that opened a lead in CRM." },
    consent: { ...nul(int), description: "Answers with a consent box ticked; null for a form without one." },
    spam: int,
    completion: nul(num),
  }),
  total: int,
  lastAt: nul(dt),
  nps: Nps,
  file: { type: "string", description: "Where the form is written: forms.yaml, or forms/<id>.yaml." },
  embedOn: { ...arr(str), description: "The hosts of the form's embed origins." },
  destinations: {
    ...arr(ref("Route")),
    description: "Where its answers go, and how sending went in the last 7 days. Products not linked in the file are left out: the answers stay in Forms.",
  },
  url: str,
});
const Question = obj(
  {
    field: str,
    label: str,
    type: str,
    answers: int,
    shown: { type: "integer", description: "Answers sent whose pages showed the question." },
    options: arr(obj({ value: str, label: str, count: int })),
    average: nul(num),
    min: nul(num),
    max: nul(num),
    scale: arr(obj({ value: int, count: int })),
    nps: Nps,
    ticked: int,
    latest: arr(obj({ response: str, text: str, at: dt })),
  },
  ["field", "label", "type", "answers", "shown"],
);

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        description: "Stable; match on this.",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "invalid-answers",
          "forbidden",
          "forbidden-origin",
          "not-found",
          "conflict",
          "closed",
          "expired",
          "proof-of-work",
          "captcha-failed",
          "unsupported-file",
          "rate-limited",
          "payload-too-large",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "cross-site",
        ],
      },
      detail: str,
      errors: {
        description: "For invalid-answers: each field and what is wrong with it.",
        ...arr(
          obj({
            field: str,
            code: en(
              "required",
              "too_short",
              "too_long",
              "too_small",
              "too_large",
              "pattern",
              "email",
              "phone",
              "url",
              "date",
              "number",
              "option",
              "too_few",
              "too_many",
              "file",
            ),
            message: str,
          }),
        ),
      },
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "forms" }, version: str }),
  ProductList: obj({ products: arr(obj({ id: str, url: str })) }),
  Summary: obj({ forms: int, week: int, failed: int, waiting: int, file: nul(map) }),
  Settings: obj({ file: nul(map), yaml: str, config: nul(map) }),
  Integrations: obj({
    links: arr(
      obj(
        {
          id: TARGET,
          linked: bool,
          url: nul(str),
          secret: { ...nul(str), description: "The environment variable the file names, never its value." },
          secretSet: bool,
          waiting: int,
          failed: int,
          lastSentAt: nul(dt),
          lastError: nul(str),
          purposes: arr(obj({ id: str, version: int })),
          error: nul(str),
        },
        ["id", "linked", "url", "secret", "secretSet", "waiting", "failed", "lastSentAt", "lastError"],
      ),
    ),
    webhooks: arr(obj({ id: str, url: str, secret: str, secretSet: bool, waiting: int, failed: int, lastSentAt: nul(dt), lastError: nul(str) })),
    analytics: nul(str),
    captcha: nul(obj({ provider: str, siteKey: str, secret: str, secretSet: bool })),
  }),
  Condition,
  PublicField,
  PublicPage,
  PublicForm,
  Route,
  FormSummary,
  FormList: obj({ forms: arr(ref("FormSummary")) }),
  FormDetail: {
    allOf: [
      ref("FormSummary"),
      obj({
        language: str,
        description: nul(str),
        definition: obj({ title: str, pages: arr(ref("PublicPage")), hidden: arr(str) }),
        yaml: { type: "string", description: "The form as it is written in its file." },
        person: obj({ email: nul(str), phone: nul(str), name: nul(str), company: nul(str), userId: nul(str) }),
        embed: obj({ url: str, script: str, frame: str, origins: arr(str) }),
        spam: obj({ minSeconds: num, rate: str, proofOfWork: nul(int), captcha: nul(str) }),
        partials: en("off", "progress", "answers"),
        sendTo: obj({
          audience: bool,
          consent: arr(obj({ field: str, purpose: str, channels: arr(str), linked: bool, version: nul(int) })),
          crm: nul(map),
          helpdesk: nul(map),
          notify: arr(str),
          webhooks: arr(str),
          traits: arr(obj({ field: str, trait: str })),
        }),
      }),
    ],
  },
  ResponseSummary,
  ResponseList: obj(
    {
      responses: arr(ref("ResponseSummary")),
      total: int,
      nextCursor: str,
      facets: obj({
        consent: { ...nul(obj({ yes: int, no: int })), description: "Answers of the status with a consent box ticked, and not; null for a form without one." },
        sources: arr(obj({ value: { type: "string", description: "utm_source, or none." }, count: int })),
      }),
    },
    ["responses", "total", "facets"],
  ),
  Delivery,
  ResponseDetail: {
    allOf: [
      ref("ResponseSummary"),
      obj({
        formName: str,
        answers: { ...nul(arr(AnswerItem)), description: "null for a partial that keeps only how far it got." },
        answeredFields: arr(str),
        shownPages: arr(int),
        meta: obj({ url: nul(str), referrer: nul(str), utm: nul(map), origin: nul(str) }),
        deliveries: arr(ref("Delivery")),
      }),
    ],
  },
  Question,
  Report: obj({
    form: str,
    views: { type: "integer", description: "Times the form was shown in the days asked." },
    started: int,
    submitted: int,
    partial: int,
    completion: nul(num),
    medianSeconds: nul(int),
    nps: Nps,
    npsWeeks: arr(obj({ week: str, score: int, promoters: int, passives: int, detractors: int, answers: int })),
    npsMonths: arr(obj({ month: str, score: int, promoters: int, passives: int, detractors: int, answers: int })),
    reasons: {
      ...arr(obj({ response: str, score: nul(int), text: str, name: nul(str), at: dt })),
      description: "The latest answers to the first text question after the NPS score.",
    },
    sources: arr(obj({ value: str, count: int })),
    days: arr(obj({ day: str, answers: int })),
    questions: arr(ref("Question")),
    pages: arr(obj({ page: int, title: nul(str), reached: int, left: int })),
    fields: arr(obj({ field: str, label: str, page: int, reached: int, answered: int })),
  }),
  Submission: obj(
    {
      token: str,
      answers: { type: "object", additionalProperties: Value, description: "By field id; hidden fields too." },
      language: str,
      page: obj({ url: str, referrer: str }, []),
      website: { type: "string", description: "The honeypot: leave it empty." },
      proof: { type: "string", description: "The proof of work's number, when the form asks for one." },
      captcha: { type: "string", description: "The captcha's answer, when the form asks for one." },
      versions: { type: "object", additionalProperties: int, description: "The version of each consent box's text the page showed." },
    },
    ["token", "answers"],
    false,
  ),
  Submitted: obj({ response: obj({ id: str }), thanks: str, redirect: nul(str) }),
  Progress: obj(
    {
      token: str,
      page: int,
      language: str,
      pages: arr(int),
      answered: { ...arr(str), description: "With partials: progress, the fields answered, without what was written." },
      answers: { type: "object", additionalProperties: Value, description: "With partials: answers, what was written so far." },
    },
    ["token"],
    false,
  ),
  FileUploaded: obj({ id: str, name: str, size: int, type: str }),
  ErasureRequest: obj({
    reference: str,
    product: { const: "audience" },
    people: obj({ emails: arr(str), phones: arr(str), userIds: arr(str) }),
  }),
  ErasureAnswer: obj({ status: en("done", "waiting"), deleted: int, detail: str }, ["status"]),
  WebhookEvent: obj({
    type: { const: "response.submitted" },
    timestamp: dt,
    data: obj({
      id: str,
      form: obj({ id: str, name: str, kind: str }),
      submittedAt: dt,
      language: str,
      answers: { type: "object", additionalProperties: Value },
      fields: arr(obj({ id: str, label: str, value: Value, text: str })),
      person: Person,
      page: obj({ url: nul(str), referrer: nul(str), utm: nul(map) }),
      files: arr(obj({ id: str, field: str, name: str, type: str, size: int, url: str })),
      url: str,
    }),
  }),
};

const listFilters = [
  query("status", "submitted (default), partial, spam or all.", en("submitted", "partial", "spam", "all")),
  query("from", "From this day, YYYY-MM-DD in the file's time_zone."),
  query("to", "Up to and including this day."),
  query("q", "Text in the person's email, name, company or any answer."),
  query("nps", "promoters, passives or detractors.", en("promoters", "passives", "detractors")),
  query("consent", "yes: a consent box ticked; no: none.", en("yes", "no")),
  query("source", "utm_source of the page it was sent from, or none."),
  {
    name: "answer.{field}",
    in: "query",
    required: false,
    description: "Answers where this field has this value, such as answer.size=51-200; repeat for more. yes or no for yes/no fields.",
    schema: str,
  },
];

const formsTag = <T extends S>(s: T) => ({ tags: ["Forms"], ...s });
const publicOp = (s: S & { responses: Record<string, unknown> }) => pub({ tags: ["Public"], ...s });

const paths: Record<string, unknown> = {
  "/api/v1/version": {
    get: pub({ operationId: "version", tags: ["Product"], summary: "The product and its version", responses: { "200": ok(ref("Version")) } }),
  },
  "/api/v1/products": {
    get: op("viewer", { operationId: "products", tags: ["Product"], summary: "The install's other products", responses: { "200": ok(ref("ProductList")) } }),
  },
  "/api/v1/summary": {
    get: op("viewer", {
      operationId: "summary",
      tags: ["Product"],
      summary: "Answers this week and sending that failed",
      responses: { "200": ok(ref("Summary")) },
    }),
  },
  "/api/v1/settings": {
    get: op("viewer", {
      operationId: "settings",
      tags: ["Product"],
      summary: "The settings file as applied",
      description: "Read-only: forms and settings are changed in forms.yaml, never through the API.",
      responses: { "200": ok(ref("Settings")) },
    }),
  },
  "/api/v1/integrations": {
    get: op("viewer", {
      operationId: "integrations",
      tags: ["Product"],
      summary: "The linked products and how sending to them goes",
      responses: { "200": ok(ref("Integrations")) },
    }),
  },
  "/api/v1/forms": {
    get: op(
      "viewer",
      formsTag({ operationId: "listForms", summary: "Every form with its answers this week and where they went", responses: { "200": ok(ref("FormList")) } }),
    ),
  },
  "/api/v1/forms/{id}": {
    get: op(
      "viewer",
      formsTag({
        operationId: "getForm",
        summary: "A form as the file sets it, with how to embed it",
        parameters: [idParam("form"), query("lang", "en, tr or de, of the languages the form is written in.")],
        responses: { "200": ok(ref("FormDetail")), "404": problem },
      }),
    ),
  },
  "/api/v1/forms/{id}/responses": {
    get: op(
      "viewer",
      formsTag({
        operationId: "listResponses",
        summary: "A form's answers, newest first",
        parameters: [idParam("form"), ...listFilters, query("limit", "1 to 200; 50 by default.", int), query("cursor", "nextCursor of the page before.")],
        responses: { "200": ok(ref("ResponseList")), "404": problem, "422": problem },
      }),
    ),
  },
  "/api/v1/forms/{id}/export": {
    get: op(
      "viewer",
      formsTag({
        operationId: "exportResponses",
        summary: "A form's answers as CSV",
        description: "The same filters as the list. A value a spreadsheet would run as a formula starts with an apostrophe.",
        parameters: [idParam("form"), ...listFilters],
        responses: { "200": { description: "CSV with a byte order mark.", content: { "text/csv": { schema: str } } }, "404": problem, "422": problem },
      }),
    ),
  },
  "/api/v1/forms/{id}/report": {
    get: op(
      "viewer",
      formsTag({
        operationId: "report",
        summary: "Each question summed up, where people left, NPS by week",
        parameters: [idParam("form"), listFilters[1], listFilters[2]],
        responses: { "200": ok(ref("Report")), "404": problem, "422": problem },
      }),
    ),
  },
  "/api/v1/responses/{id}": {
    get: op("viewer", {
      operationId: "getResponse",
      tags: ["Answers"],
      summary: "One answer, and where it went",
      parameters: [idParam("answer")],
      responses: { "200": ok(ref("ResponseDetail")), "404": problem },
    }),
    delete: op("editor", {
      operationId: "deleteResponse",
      tags: ["Answers"],
      summary: "Delete an answer and its files",
      parameters: [idParam("answer")],
      responses: { "204": { description: "Deleted." }, "404": problem },
    }),
  },
  "/api/v1/responses/{id}/spam": {
    post: op("editor", {
      operationId: "markSpam",
      tags: ["Answers"],
      summary: "Mark an answer as spam",
      description: "What has not been sent yet is not sent.",
      parameters: [idParam("answer")],
      responses: { "200": ok(ref("ResponseDetail")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/responses/{id}/not-spam": {
    post: op("editor", {
      operationId: "markNotSpam",
      tags: ["Answers"],
      summary: "Take an answer out of spam",
      description: "It is sent where its form says, as if it had just come.",
      parameters: [idParam("answer")],
      responses: { "200": ok(ref("ResponseDetail")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/responses/{id}/retry": {
    post: op("editor", {
      operationId: "retry",
      tags: ["Answers"],
      summary: "Send what failed again",
      parameters: [idParam("answer")],
      responses: { "200": ok(ref("ResponseDetail")), "404": problem },
    }),
  },
  "/api/v1/files/{id}": {
    get: op("viewer", {
      operationId: "getFile",
      tags: ["Answers"],
      summary: "A file someone attached",
      description: "PNG, JPEG, GIF and WebP are shown; anything else is downloaded. Served with a sandboxing Content-Security-Policy.",
      parameters: [idParam("file")],
      responses: {
        "200": { description: "The file.", content: { "application/octet-stream": { schema: str }, "image/png": { schema: str } } },
        "404": problem,
      },
    }),
  },
  "/api/v1/erasures": {
    post: op("admin", {
      operationId: "erase",
      tags: ["Contracts"],
      summary: "Delete a person on request, as Audience asks",
      description:
        "Every answer, sent or not, whose person has one of the emails, phone numbers (by their digits) or user ids goes, with its files and what was waiting to be sent. The same reference answers the same again.",
      requestBody: json(ref("ErasureRequest")),
      responses: { "200": ok(ref("ErasureAnswer"), "Deleted."), "400": problem, "422": problem },
    }),
  },

  "/api/v1/public/forms/{id}": {
    get: publicOp({
      operationId: "publicForm",
      summary: "A form, as a page draws it",
      description:
        "From the form's own page, from a page on one of the form's embed origins (CORS), or from a server (no Origin). Comes with a fresh token. The language is lang, else the browser's, among those the form is written in.",
      parameters: [idParam("form"), query("lang", "en, tr or de.")],
      responses: { "200": ok(ref("PublicForm")), "403": problem, "404": problem },
    }),
  },
  "/api/v1/public/forms/{id}/responses": {
    post: publicOp({
      operationId: "submit",
      summary: "Send an answer",
      description:
        "Checked as the form's pages and show_if say. The same token sends one answer: sending it again answers 200 with the same id. An answer the spam filters take for a bot's is answered the same way and kept as spam.",
      parameters: [idParam("form")],
      requestBody: json(ref("Submission")),
      responses: {
        "201": ok(ref("Submitted"), "Taken."),
        "200": ok(ref("Submitted"), "This token's answer, taken before."),
        "400": problem,
        "403": problem,
        "404": problem,
        "409": problem,
        "413": problem,
        "422": problem,
        "429": problem,
        "503": problem,
      },
    }),
  },
  "/api/v1/public/forms/{id}/progress": {
    post: publicOp({
      operationId: "progress",
      summary: "Say how far a page got",
      description:
        "Kept as the form's partials setting says: nothing (off), the pages reached and fields answered (progress), or the answers so far (answers).",
      parameters: [idParam("form")],
      requestBody: json(ref("Progress")),
      responses: { "204": { description: "Noted." }, "400": problem, "403": problem, "404": problem, "422": problem, "429": problem },
    }),
  },
  "/api/v1/public/forms/{id}/files": {
    post: publicOp({
      operationId: "upload",
      summary: "Attach a file to a file field",
      description: "The body is the file; x-file-name its name, URI-encoded. Its bytes must be one of the field's types. Send its id as the field's answer.",
      parameters: [idParam("form"), { name: "token", in: "query", required: true, schema: str }, { name: "field", in: "query", required: true, schema: str }],
      requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      responses: { "201": ok(ref("FileUploaded")), "403": problem, "404": problem, "413": problem, "415": problem, "422": problem, "429": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const webhooks = {
  responseSubmitted: {
    post: {
      operationId: "responseSubmitted",
      summary: "An answer was sent, to a webhook in the file",
      description:
        'Signed as Standard Webhooks (standardwebhooks.com) signs: webhook-signature is v1,<base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<body>">, keyed with the secret the file names (a whsec_<base64> secret is used as those bytes). Reject a timestamp more than 5 minutes off. Answer 2xx; anything else is tried again after 1, 2, 4 minutes and so on, for three days, and a 4xx but 408 and 429 is not tried again.',
      parameters: [
        { name: "webhook-id", in: "header", required: true, schema: str },
        { name: "webhook-timestamp", in: "header", required: true, schema: int },
        { name: "webhook-signature", in: "header", required: true, schema: str },
      ],
      requestBody: json(ref("WebhookEvent")),
      responses: { "200": { description: "Taken." } },
    },
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy Forms",
    version,
    description:
      "Lead, contact and NPS forms set in forms.yaml: the public API pages and the embed script call, the answers for members, and the erasure contract Audience calls. Viewers read everything; editors mark spam, send again and delete answers; admins take erasures.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  webhooks,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
