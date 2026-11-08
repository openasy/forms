import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- One person's answer to a form: started (partial), sent (submitted), or taken for a bot's (spam). token_hash is the
   -- hash of the token the page was served with, so one page view makes at most one answer.
   CREATE TABLE responses (
     id TEXT PRIMARY KEY,
     form TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('partial', 'submitted', 'spam')),
     token_hash TEXT NOT NULL UNIQUE,
     language TEXT NOT NULL,
     -- The furthest page reached, and every page shown (a JSON list of their indexes).
     page INTEGER NOT NULL DEFAULT 0,
     pages TEXT NOT NULL DEFAULT '[]',
     -- The fields answered, by id (JSON), also for a partial that keeps no answers.
     answered TEXT NOT NULL DEFAULT '[]',
     -- The answers (JSON); null for a partial that keeps only how far it got.
     answers TEXT,
     -- Where it was sent from: the page's address, the referrer, utm_*, the embedding origin (JSON).
     meta TEXT NOT NULL DEFAULT '{}',
     -- Who answered, from the form's person fields: what deletion on request and search find them by.
     email TEXT,
     phone TEXT,
     phone_key TEXT,
     name TEXT,
     company TEXT,
     user_id TEXT,
     nps INTEGER,
     spam_reason TEXT,
     started_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     submitted_at TEXT
   );
   CREATE INDEX responses_form ON responses (form, status, submitted_at);
   CREATE INDEX responses_started ON responses (form, started_at);
   CREATE INDEX responses_email ON responses (email);
   CREATE INDEX responses_phone ON responses (phone_key);
   CREATE INDEX responses_user ON responses (user_id);
   -- A file someone attached. It belongs to the page view that sent it until an answer takes it; one left alone is
   -- deleted after a day.
   CREATE TABLE files (
     id TEXT PRIMARY KEY,
     form TEXT NOT NULL,
     field TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     response_id TEXT REFERENCES responses (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     data BLOB NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX files_response ON files (response_id);
   CREATE INDEX files_loose ON files (created_at) WHERE response_id IS NULL;
   -- Where an answer goes, one row each: Consent, Audience, CRM, Helpdesk, an email, a webhook. Sent in the background
   -- and tried again until taken; payload is what is sent, made when the answer came.
   CREATE TABLE deliveries (
     id INTEGER PRIMARY KEY,
     response_id TEXT NOT NULL REFERENCES responses (id) ON DELETE CASCADE,
     target TEXT NOT NULL CHECK (target IN ('consent', 'audience', 'crm', 'helpdesk', 'mail', 'webhook')),
     name TEXT,
     state TEXT NOT NULL CHECK (state IN ('waiting', 'sent', 'failed')),
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at TEXT NOT NULL,
     error TEXT,
     result TEXT,
     created_at TEXT NOT NULL,
     done_at TEXT
   );
   CREATE INDEX deliveries_due ON deliveries (state, next_at);
   CREATE INDEX deliveries_response ON deliveries (response_id);
   -- How often each form was shown, by day in the file's time zone: a count, nothing about who saw it.
   CREATE TABLE views (form TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (form, day)) WITHOUT ROWID;
   -- Deletions Audience asked for, by their reference: kept so asking again gives the same answer.
   CREATE TABLE erasures (reference TEXT PRIMARY KEY, at TEXT NOT NULL, deleted INTEGER NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

/** The key that signs the form pages' tokens: made once, kept in the database, so a restart keeps open pages working. */
export function pageKey(db: DatabaseSync): Buffer {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'page_key'").get() as { value: string } | undefined;
  if (row) return Buffer.from(row.value, "base64");
  const key = randomBytes(32);
  db.prepare("INSERT INTO settings (key, value) VALUES ('page_key', ?)").run(key.toString("base64"));
  return key;
}
