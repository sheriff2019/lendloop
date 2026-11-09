import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { PURPOSES, SIGNATURE_HEADER, TIMESTAMP_HEADER, type Purpose, secret, verify } from "./lib/hmac";

/**
 * The ONLY doors n8n has into Convex. Every route:
 *  1. reads the raw body (the bytes that were signed),
 *  2. verifies the HMAC signature for THIS route's purpose and the timestamp,
 *  3. validates the JSON shape,
 *  4. calls an internal, idempotent function.
 * Failures answer with a short code and never echo the request back.
 */

const MAX_BODY = 16 * 1024;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function authenticate(
  req: Request,
  purpose: Purpose,
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  const body = await req.text();
  if (body.length > MAX_BODY) return { ok: false, response: json(413, { error: "too_large" }) };
  let key: string;
  try {
    key = secret("N8N_TO_CONVEX_SECRET");
  } catch {
    console.error("N8N_TO_CONVEX_SECRET is not configured");
    return { ok: false, response: json(503, { error: "not_configured" }) };
  }
  const result = await verify(
    key,
    purpose,
    body,
    req.headers.get(TIMESTAMP_HEADER),
    req.headers.get(SIGNATURE_HEADER),
  );
  if (!result.ok) {
    // Log the reason (useful when debugging clocks), never the body.
    console.warn(`Rejected ${purpose} request: ${result.reason}`);
    return { ok: false, response: json(401, { error: "invalid_signature" }) };
  }
  return { ok: true, body };
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const status = (v: unknown) => (v === "sent" || v === "failed" ? v : undefined);

type Handler = (ctx: ActionCtx, data: Record<string, unknown>) => Promise<Response>;

function signedPost(purpose: Purpose, handle: Handler) {
  return httpAction(async (ctx, req) => {
    const auth = await authenticate(req, purpose);
    if (!auth.ok) return auth.response;
    const data = parse(auth.body);
    if (!data) return json(400, { error: "invalid_json" });
    return handle(ctx, data);
  });
}

const http = httpRouter();

/** Workflow 2: the list of overdue loans to remind today. */
http.route({
  path: "/n8n/overdue",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(req, PURPOSES.overdueList);
    if (!auth.ok) return auth.response;
    return json(200, await ctx.runQuery(internal.automation.overdueList, {}));
  }),
});

/** Workflow 2: write back whether each reminder went out. Idempotent per loan per day. */
http.route({
  path: "/n8n/reminders",
  method: "POST",
  handler: signedPost(PURPOSES.reminderResult, async (ctx, d) => {
    const loanId = str(d.loanId, 64);
    const day = str(d.day, 10);
    const s = status(d.status);
    if (!loanId || !day || !s) return json(400, { error: "invalid_fields" });
    const r = await ctx.runMutation(internal.automation.recordReminder, {
      loanId,
      day,
      status: s,
      error: str(d.error, 1000),
      executionId: str(d.executionId, 64),
    });
    return "error" in r ? json(422, r) : json(200, r);
  }),
});

/** Workflow 1: write back whether the notification email went out. Idempotent per event. */
http.route({
  path: "/n8n/notifications",
  method: "POST",
  handler: signedPost(PURPOSES.notificationResult, async (ctx, d) => {
    const eventId = str(d.eventId, 64);
    const s = status(d.status);
    if (!eventId || !s) return json(400, { error: "invalid_fields" });
    const r = await ctx.runMutation(internal.automation.recordNotification, {
      eventId,
      status: s,
      error: str(d.error, 1000),
      executionId: str(d.executionId, 64),
    });
    return "error" in r ? json(422, r) : json(200, r);
  }),
});

/** Workflow 3 (error workflow): record a failed n8n run so it shows on the admin page. */
http.route({
  path: "/n8n/failures",
  method: "POST",
  handler: signedPost(PURPOSES.workflowFailure, async (ctx, d) => {
    const workflow = str(d.workflow, 200);
    const message = str(d.message, 2000) ?? "No error message";
    const executionId = str(d.executionId, 64);
    if (!workflow || !executionId) return json(400, { error: "invalid_fields" });
    return json(
      200,
      await ctx.runMutation(internal.automation.recordFailure, {
        workflow,
        node: str(d.node, 200),
        message,
        executionId,
      }),
    );
  }),
});

export default http;
