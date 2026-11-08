# forms

[![CI](https://github.com/openasy/forms/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/forms/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Forms product: lead, contact and NPS forms written in a file, embedded with
one script tag or shown on a page of their own, with the answers kept in your install. Each answer goes where its form
says: the person to Audience, a lead to CRM, a ticket to Helpdesk, a ticked consent box to Consent with the text the
person saw, an email to the team and a signed webhook. Spam is filtered by a hidden field, timing and rate, without a
third-party CAPTCHA unless the file names one. It keeps to forms and short surveys; it takes no payments.

```
forms.yaml, forms/*.yaml ──▶ forms ◀── a site: <script src=".../embed.js" data-form="demo">, or /f/demo
                               │ ▲
                               │ └── Audience: POST /api/v1/erasures
                               ├──▶ Consent: POST /api/v1/consents (source form), GET /api/v1/purposes
                               ├──▶ Audience: POST /api/v1/events (source forms, form_submitted)
                               ├──▶ CRM: POST /api/v1/leads (source forms)
                               ├──▶ Helpdesk: POST /api/v1/public/tickets (the forms source's key)
                               ├──▶ webhooks (Standard Webhooks signatures), SMTP
                               └──  Analytics: its script on the form pages counts views and submits
```

## Forms are files

A form is written in `forms.yaml` under `forms:`, or in a file of its own in the `forms` folder next to it
(`forms/demo.yaml`, named by the form's id, holding the same map). No screen or API route adds or changes a form: forms
are reviewed like code. The UI's builder edits a draft of the form's YAML in the browser (questions, help, required,
order, new fields, show rules) with a live preview drawn by the form script itself, and **Save as YAML** gives the text
to commit. Forms reads the file and the folder again within a minute of a change and applies them whole or not at all;
a mistake leaves the last good version in place, and Settings and the log say which form and field to fix.

```yaml
forms:
  demo:
    name: Demo request
    kind: lead # lead, contact, nps or survey
    title: { en: Book a demo, tr: Demo isteyin, de: Demo anfragen }
    embed: [https://www.example.com] # origins whose pages may show it
    hidden: [plan] # filled from the page's address (?plan=pro) or the tag's data-value-plan
    pages:
      - title: About you
        fields:
          - { id: name, type: text, label: Name, required: true }
          - { id: email, type: email, label: Work email, required: true }
          - { id: size, type: choice, label: Team size, options: [1-10, 11-50, 51-200, 200+], required: true }
      - title: Your team
        show_if: { field: size, in: [51-200, 200+] } # skipped for smaller teams
        fields:
          - { id: region, type: select, label: Region, options: [emea, americas, apac], trait: region }
      - fields:
          - { id: brief, type: file, label: A brief, types: [pdf, png], max_size: 5MB }
          - { id: marketing, type: consent, purpose: marketing, channels: [email], label: Send me offers by email }
    thanks: { text: Thank you., redirect: https://www.example.com/thanks }
    send_to:
      crm: { title: "Demo: {company}", owner_by: { field: region, owners: { emea: emily@example.com } } }
      notify: [sales@example.com]
      webhooks: [zapier]
```

- **Field types**: `text`, `textarea`, `email`, `phone`, `number`, `url`, `date`, `choice` (one), `choices` (many),
  `select`, `yes_no`, `rating` (stars, `max` 3 to 10), `scale` (`min` to `max`, with `min_label` and `max_label`),
  `nps` (0 to 10), `file`, `consent` and `statement` (text, no answer). Every text may be one text or `{ en, tr, de }`;
  the page is in `?lang=`, else the first of the browser's languages the form's title is written in, else `language`.
- **Checks**: `required`; `min` and `max` (characters for text, the value for numbers, options ticked for `choices`);
  `pattern` with `pattern_message` for text and phone; the formats of email, phone, web address and date; options
  from the list only. The page shows the same checks as people type; the server checks every answer again.
- **Rules**: `show_if` on a page or a field is a condition, or a list that must all hold, on a hidden field or an
  earlier answer: `is`, `not`, `in`, `answered`, `above`, `below`, and `{ any: [...] }`. A page not shown is skipped;
  answers to fields not shown are dropped and never make another rule hold. Forms keeps to forms and short surveys: no
  jumping back, scoring or long branching.
- **Who answered**: `person: { email, phone, name, company, user_id }` names the fields; by default the first email
  and phone fields, `name`, `company` and a hidden `user_id`. Consent, Audience, CRM, Helpdesk and deletion use them.
- **Closing**: `closed: true`, `closes: 2026-12-31`, or `limit: 500` answers; the page then says so (`closed_text`).

## The form on a page

```html
<script src="https://forms.example.com/embed.js" data-form="demo" async></script>
<!-- or anywhere on the page, as many as needed: -->
<div data-openasy-form="demo"></div>
<div data-openasy-form="demo" data-mode="popup" data-button="Ask for a demo"></div>
```

The script (about 11 KiB gzipped, no dependencies) draws a plain `<form>` in the page itself, in the page's font and
colours (`--oaf-accent` sets the buttons), one page at a time with Next and Back and a progress bar. Pages on an origin
not in the form's `embed` list are refused (CORS). `/f/demo` is the form's own page, with the install's accent; it can
be framed by the `embed` origins (`/f/demo?frame=1`). Any field and hidden field can be filled from the address,
`?email=ayse@example.com&utm_campaign=autumn`, and `?hide=email` hides fields that were filled. `utm_source`,
`utm_medium` and `utm_campaign` of the page are kept with the answer; the rest of its query string is not.

**Analytics.** With `analytics: https://analytics.example.com/s/forms.js` in the file, the form pages load that
Analytics site's script (list Forms' address in the site's `domains`, and `forms: true` for field reports). The form
is a real `<form id="oaf-demo">`: Analytics' form tracking sees it started and sent, by field name and kind, never a
value. Next is not a submit; the one submit event is the one that sends. The script also calls
`openasy.track("form_view", { form })` and `openasy.track("form_submit", { form })` when Analytics is on the page, for
goals such as `{ name: Demo requested, event: form_submit }`. Nothing typed is passed.

## Spam

- **The token.** Every form a page loads comes with a token signed with a key kept in the database, naming the form
  and when it was served, valid two days. One token makes one answer: sending it again answers 200 with the same id.
- **The hidden field.** `website`, which people never see and bots fill.
- **Time.** An answer sooner than `spam.min_time` (3s) after the page was served.
- **Rate.** `spam.rate` answers a form takes from one address (`5/m`, `5/10m`, `30/h`); past it the page is told to
  wait (429). Addresses are counted in memory, hashed with a key made at start, and never stored. Behind a proxy, set
  `FORMS_TRUST_PROXY=true` so the last `X-Forwarded-For` address counts.
- **Proof of work**, when `spam.proof_of_work` is set (bits, 8 to 22; `true` is 16): the page finds a number whose
  SHA-256 with the token starts with that many zero bits, while people type; the server checks it in one hash.
- **A captcha**, only when the file names one: `captcha: { provider: turnstile or hcaptcha, site_key, secret }`. The
  page loads the provider's widget on the last page and the server checks the answer at the provider's siteverify,
  without the person's address. A form can leave it out with `spam: { captcha: false }`.

An answer caught by the hidden field or by time is answered as if taken and kept as spam for `keep.spam` (30 days),
sent nowhere. Members see it under Answers, Spam, and **Not spam** sends it where its form says. A missing proof of
work or a failed captcha is refused (422), so a person can try again.

## Partial answers

What is kept of an answer not sent is set by `partials` (for every form, or per form):

- `progress` (the default): which pages were reached and which fields answered, never what was written. Results shows
  where people stop from it.
- `answers`: what was written so far too (never files or consent boxes), shown under Answers, Partial.
- `off`: nothing.

The page reports progress on the first answer, on Next and when the page is hidden. A partial is never sent anywhere;
sending the answer turns it into a complete one. Partials are deleted after `keep.partials` (30 days).

## Files

A `file` field takes the `types` listed (`pdf`, `png`, `jpeg`, `gif`, `webp`, `txt`, `csv`; PDF, PNG and JPEG by
default) up to `max_size` (5MB by default, at most 20MB). The page sends the file when it is chosen; its bytes must be
the type it claims (a page renamed `.png` is refused). It is kept in the database with the answer, and a file no
answer took is deleted after a day. Members open it at `/api/v1/files/{id}`: images inline, anything else as a
download, always with `Content-Security-Policy: default-src 'none'; sandbox`. Files are not scanned for malware.

## Where answers go

Each destination is an outbox row sent in the background: a failure is tried again after 1, 2, 4 minutes and so on up
to 6 hours, for three days; a refusal (a 4xx but 408 and 429, or an unset secret) stops at once. Each answer shows
where it went, what came back (the CRM deal, the Helpdesk ticket) and errors, with **Send again**. A product not linked
in the file is not offered: its answers stay in Forms.

**Consent** (`consent: { url, token }`, a Consent token of the editor role). Forms reads `GET /api/v1/purposes` every
five minutes and shows, next to a consent box, the text of the purpose's current version in the page's language. A
ticked box is recorded with `POST /api/v1/consents`:

```json
{ "person": { "email": "gizem@avci.example" }, "source": "form", "via": "forms/demo",
  "answers": [{ "purpose": "marketing", "channel": "email", "granted": true, "version": 2,
                "at": "2026-11-08T09:30:00Z", "proof": "Demo request (forms/demo), answer r1: Offers ..." }] }
```

The version is the one the page showed. An unticked box is no and is never recorded, so it does not withdraw an
earlier yes. Until Forms has read the purposes, a box shows its `label` and is recorded without a version, which
Consent reads as the version in force; the proof keeps the text shown.

**Audience** (`audience: { url, token }`, editor role; Audience lists `forms` under its `sources`). Each answer with an
email, phone or user id is a `form_submitted` event at `POST /api/v1/events`, with source `forms`, id `forms:<answer>`,
the person, properties `form`, `form_name`, `kind`, `nps` and `page`, and the traits fields name (`trait: city`).
`send_to: { audience: false }` leaves a form out. When a person is deleted in Audience (with `delete: true` and a Forms
token of the admin role), it calls `POST /api/v1/erasures` here: every answer, sent or not, whose email, phone number
(by its digits) or user id is in the request goes, with its files and what was waiting to be sent. Forms answers 200
`{ "status": "done", "deleted": n }`, the same again for the same reference; it never answers `waiting`.

**CRM** (`crm: { url, token }`, editor role; `send_to.crm` on a form). `POST /api/v1/leads` with `external_id:
forms-<answer>`, `source: forms`, the person's name, email, phone and company, the page, referrer and utm, `title`
(with `{field}` filled in), `value`, the owner by `owner_by` or `owner`, and every answer as `message`. CRM opens the
deal in its own `leads.stage`; Forms cannot choose the stage.

**Helpdesk** (`helpdesk: { url, key }`, the key of a Helpdesk source; `send_to.helpdesk: { form, subject, message }`).
`POST /api/v1/public/tickets` with the key as bearer, the person's email and name, `subject`, the `message` field's
answer (the form's first textarea by default, else every answer), `form` for Helpdesk's routing rules, the other
answers as `fields`, the language and `external_id: forms-<answer>`.

**Email** (`mail` in the file; `send_to.notify`). The answers, the page it came from and a link to it, reply-to the
person.

**Webhooks** (`webhooks.<id>: { url, secret }`; `send_to.webhooks: [<id>]`). `POST` of
`{ "type": "response.submitted", "timestamp", "data": { id, form, submittedAt, answers, fields, person, page, files,
url } }`, signed as [Standard Webhooks](https://www.standardwebhooks.com) signs: `webhook-id`, `webhook-timestamp`
and `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">` with the secret (a `whsec_` secret is used as
its base64 bytes). openapi.json describes it under `webhooks`.

## What members see

**Forms**: every form with its answers in the last 7 days, the share of views, leads opened in CRM, consent given,
spam held, and where it sends. A form's page has its fields, rules, the embed code and a prefilled link builder, and
where its answers go. **Answers**: one form's answers with search, consent and source filters, CSV export (formulas a
spreadsheet would run start with an apostrophe), each answer with where it went; partial answers; spam. **Results**:
views, started, sent, the median time to finish, how many reached each field and where most stopped, each question's
answers, sources; for NPS forms the score by month, promoters, passives and detractors, and the latest reasons.
Viewers read everything; editors mark spam, send again and delete answers; admins manage members and tokens.

## The settings file

Everything but the answers is in [config/forms.yaml](./config/forms.yaml) and the `forms` folder beside it. The UI
shows them read-only under Settings and on each form's page.

| Key | Default | |
| --- | --- | --- |
| `language`, `time_zone` | `en`, `Europe/Istanbul` | Pages' fallback language; days in reports |
| `forms.<id>` | | A form, as above; or `forms/<id>.yaml` |
| `spam` | `{ min_time: 3s, rate: 5/m }` | `{ min_time, rate, proof_of_work, captcha }`; a form may set its own |
| `partials` | `progress` | `off`, `progress` or `answers`; a form may set its own |
| `keep` | `{ partials: 30d, spam: 30d }` | `responses` too (kept until deleted by default) |
| `mail` | | `{ host, port, security, user, password, from }`; `password` names a variable |
| `analytics` | | The script of an Analytics site, on every form page |
| `captcha` | | `{ provider: turnstile or hcaptcha, site_key, secret }` |
| `consent`, `audience`, `crm` | | `{ url, token }`; `token` names a variable |
| `helpdesk` | | `{ url, key }`; `key` names a variable |
| `webhooks.<id>` | | `{ url, secret }`; `secret` names a variable |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/forms.yaml
docker compose up -d
docker compose logs forms | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `FORMS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `FORMS_CONFIG` | `/config/forms.yaml` | The settings file |
| `FORMS_DIR` | the `forms` folder next to it | One form per file |
| the variables the file names | | Tokens, the Helpdesk key, webhook secrets, the mail password, the captcha secret |
| `FORMS_TRUST_PROXY` | `false` | `true` reads the visitor's address from `X-Forwarded-For` for rate limits |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `FORMS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key for sign-in secrets |
| `FORMS_DB` | `/data/forms.db` | SQLite file (WAL), on the `/data` volume |
| `FORMS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `FORMS_HEADLESS` | `false` | `true` serves no team UI; the API, form pages and embed stay |
| `FORMS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in for the team, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Metrics
include answers by status, answers taken by form and result, and what is waiting or failed by destination. The form
pages and their API are logged by route only, never with their query string. The API reference is at `/api/docs/`.

## Develop

```bash
npm install
npm test           # the file and the folder, show_if and checks, the public API with spam filters, files and partial
                   # answers, every destination against fakes that check requests with the other products' openapi.json,
                   # erasure, reports and CSV, SMTP against an in-process server, the form script in jsdom, and every
                   # API response against openapi.json
npm run openapi    # writes openapi.json after an API change; a test fails while it is out of date
node scripts/siblings.ts   # copies the other products' contracts into server/siblings.json, from a checkout beside them
npm run dev        # the UI, with the API on :8080
```

What is tested against fakes only: Consent, Audience, CRM and Helpdesk are fakes in `server/fakes.ts` that check each
request and their own answers against the schemas copied from those products' `openapi.json` (`server/siblings.json`;
a test compares the copy with the products' files when they are checked out next to this one). Turnstile's and
hCaptcha's siteverify are a fake that answers `{ success }`; their widgets are not loaded in tests. Analytics' script is
not run in the tests: the form script's tests check what it relies on (one real `submit` event on a `<form>` with an id,
named fields, `openasy.track` with the form's id only). SMTP is tested without TLS.

The team UI follows the Forms screens in the [ui](https://github.com/openasy/ui) Storybook. Its read-only Settings page
is rebuilt here from published components (`web/src/FileSettings.tsx`) until the shared page is in a published
`@openasy/ui`.

## Licence

AGPL-3.0 (ADR 0008).
