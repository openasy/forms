// How Forms tells people from bots without a third-party CAPTCHA (one can be added in the file):
//
// - The token. Every form a page loads comes with a token signed with the product's key, naming the form and when it
//   was served. An answer without a valid one is refused; one sent sooner than the form's min_time after the page was
//   served is taken for a bot's. One token makes one answer, so sending the same twice gives the same answer back.
// - The hidden field. The page has a text field people never see (website); a bot that fills every field fills it.
// - The rate. A form takes `rate` answers from one address; past it the address waits.
// - Proof of work, when the file asks for it: the page finds a number that, hashed with the token, starts with the
//   form's count of zero bits. A browser does it while the person types; a bot pays for every answer.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64 = (b: Buffer) => b.toString("base64url");

/** Tokens live two days: a page left open longer is loaded again. */
export const TOKEN_LIFE = 2 * 86_400_000;

export function createTokens(key: Buffer, clock: () => number) {
  const sign = (form: string, issued: string, nonce: string) => b64(createHmac("sha256", key).update(`${form}.${issued}.${nonce}`).digest()).slice(0, 32);
  return {
    issue(form: string): string {
      const issued = clock().toString(36);
      const nonce = b64(randomBytes(12));
      return `${issued}.${nonce}.${sign(form, issued, nonce)}`;
    },
    /** When the token was served, or why it is not one for this form: invalid, or expired. */
    read(form: string, token: unknown): { issued: number } | { error: "invalid" | "expired" } {
      if (typeof token !== "string" || token.length > 120) return { error: "invalid" };
      const [issued, nonce, sig, extra] = token.split(".");
      if (!issued || !nonce || !sig || extra !== undefined || !/^[a-z0-9]{1,12}$/.test(issued)) return { error: "invalid" };
      const a = Buffer.from(sig);
      const b = Buffer.from(sign(form, issued, nonce));
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: "invalid" };
      const at = parseInt(issued, 36);
      if (at > clock() + 60_000 || clock() - at > TOKEN_LIFE) return { error: "expired" };
      return { issued: at };
    },
  };
}
export type Tokens = ReturnType<typeof createTokens>;

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Leading zero bits of a hash. */
function zeroBits(h: Buffer): number {
  let n = 0;
  for (const byte of h) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(byte) - 24;
    break;
  }
  return n;
}

/** Whether sha256("<token>:<nonce>") starts with `bits` zero bits. */
export function workDone(token: string, nonce: unknown, bits: number): boolean {
  if (typeof nonce !== "string" || !/^[0-9]{1,12}$/.test(nonce)) return false;
  return zeroBits(createHash("sha256").update(`${token}:${nonce}`).digest()) >= bits;
}

/** Finds a nonce, as the page does; for tests and scripts. */
export function doWork(token: string, bits: number): string {
  for (let i = 0; ; i++) if (workDone(token, String(i), bits)) return String(i);
}

/**
 * Counts what each address did in a sliding window, in memory. The address is hashed with a key that changes at every
 * start, so the counts hold no address that could be read back.
 */
export function createLimiter(clock: () => number) {
  const salt = randomBytes(16);
  const hits = new Map<string, number[]>();
  return {
    /** Takes one, or says how many seconds to wait. */
    take(kind: string, address: string, n: number, perMs: number): number | null {
      const key = createHash("sha256").update(salt).update(`${kind}|${address}`).digest("base64url").slice(0, 22);
      const now = clock();
      const list = (hits.get(key) ?? []).filter((t) => t > now - perMs);
      if (list.length >= n) {
        hits.set(key, list);
        return Math.max(1, Math.ceil((list[0]! + perMs - now) / 1000));
      }
      list.push(now);
      hits.set(key, list);
      if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some((t) => t > now - 86_400_000)) hits.delete(k);
      return null;
    },
  };
}
export type Limiter = ReturnType<typeof createLimiter>;
