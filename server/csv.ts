// CSV out, as spreadsheets read it (RFC 4180): fields with a separator, quote or line break are quoted, quotes doubled.
// A value a spreadsheet would run as a formula (=, +, -, @, tab, carriage return first) starts with an apostrophe, so
// an answer cannot run in the reader's Excel.

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The rows as CSV with CRLF line ends and a byte order mark, so Excel reads the Turkish letters. */
export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
