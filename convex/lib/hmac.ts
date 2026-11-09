/**
 * HMAC-SHA256 request signing, used in BOTH directions:
 *   Convex → n8n   secret CONVEX_TO_N8N_SECRET  (outbox deliveries)
 *   n8n → Convex   secret N8N_TO_CONVEX_SECRET  (overdue list, write-backs, failures)
 *
 * Signed string:  "<unix seconds>.<purpose>.<raw body>"
 * Headers:        X-LendLoop-Timestamp: <unix seconds>
 *                 X-LendLoop-Signature: v1=<hex hmac>
 *
 * `purpose` binds a signature to ONE endpoint, so a captured "write a reminder"
 * request cannot be replayed against "record a failure". The timestamp limits
 * replay to a 5-minute window. Verification uses crypto.subtle.verify, which
 * compares in constant time.
 */

export const SIGNATURE_HEADER = "X-LendLoop-Signature";
export const TIMESTAMP_HEADER = "X-LendLoop-Timestamp";
export const MAX_SKEW_SECONDS = 300;

export const PURPOSES = {
  loanEvent: "loan-event",
  overdueList: "overdue-list",
  reminderResult: "reminder-result",
  notificationResult: "notification-result",
  workflowFailure: "workflow-failure",
} as const;
export type Purpose = (typeof PURPOSES)[keyof typeof PURPOSES];

const enc = new TextEncoder();

async function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sign(
  secret: string,
  purpose: Purpose,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<{ timestamp: string; signature: string }> {
  const mac = await crypto.subtle.sign("HMAC", await key(secret, "sign"), enc.encode(`${timestamp}.${purpose}.${body}`));
  return { timestamp: String(timestamp), signature: `v1=${toHex(mac)}` };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export async function verify(
  secret: string,
  purpose: Purpose,
  body: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(timestampHeader) || !signatureHeader.startsWith("v1=")) {
    return { ok: false, reason: "malformed" };
  }
  const ts = Number(timestampHeader);
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "expired" };
  const given = fromHex(signatureHeader.slice(3));
  if (!given) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await key(secret, "verify"),
    given,
    enc.encode(`${ts}.${purpose}.${body}`),
  );
  return valid ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Reads a required secret; refuses to run with a missing or toy secret. */
export function secret(name: "CONVEX_TO_N8N_SECRET" | "N8N_TO_CONVEX_SECRET"): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} is not set (or shorter than 32 characters).`);
  }
  return value;
}
