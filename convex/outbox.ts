import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { EventType } from "./lib/domain";
import { PURPOSES, SIGNATURE_HEADER, TIMESTAMP_HEADER, secret, sign } from "./lib/hmac";

/**
 * Convex → n8n delivery (workflow 1, "Request notification").
 *
 * enqueue() runs INSIDE the mutation that changed the loan, so the change and
 * the event commit together. deliver() then POSTs the signed event to the n8n
 * webhook and retries with backoff. After MAX_ATTEMPTS the row is marked dead
 * and an automationFailure is recorded, so nothing fails silently.
 */

export const MAX_ATTEMPTS = 5;
// Delay before attempt 2, 3, 4, 5.
export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000];
const TIMEOUT_MS = 10_000;

type Party = Pick<Doc<"users">, "firstName" | "email">;

/** Who hears about which change. Only the person the change matters to. */
const RECIPIENT: Record<EventType, "owner" | "borrower"> = {
  "loan.requested": "owner",
  "loan.approved": "borrower",
  "loan.declined": "borrower",
  "loan.cancelled": "owner",
  "loan.returned": "borrower",
};

/**
 * The event body n8n receives. Data minimisation: exactly the fields one email
 * needs — no surnames, no other person's email, no tool description/condition,
 * no roles, no internal user ids.
 */
export function buildPayload(args: {
  eventId: string;
  type: EventType;
  loan: Doc<"loans">;
  toolName: string;
  owner: Party;
  borrower: Party;
  reason?: string;
  occurredAt: number;
}): string {
  const toOwner = RECIPIENT[args.type] === "owner";
  const recipient = toOwner ? args.owner : args.borrower;
  const other = toOwner ? args.borrower : args.owner;
  return JSON.stringify({
    eventId: args.eventId,
    type: args.type,
    loanId: args.loan._id,
    recipient: { firstName: recipient.firstName, email: recipient.email },
    otherParty: { firstName: other.firstName },
    tool: { name: args.toolName },
    dates: { start: args.loan.startDate, end: args.loan.endDate },
    ...(args.reason ? { reason: args.reason } : {}),
    occurredAt: new Date(args.occurredAt).toISOString(),
  });
}

export async function enqueue(
  ctx: MutationCtx,
  type: EventType,
  loanId: Id<"loans">,
  reason?: string,
): Promise<Id<"outbox">> {
  const loan = await ctx.db.get(loanId);
  if (!loan) throw new Error("enqueue: loan not found");
  const [tool, owner, borrower] = await Promise.all([
    ctx.db.get(loan.toolId),
    ctx.db.get(loan.ownerId),
    ctx.db.get(loan.borrowerId),
  ]);
  if (!tool || !owner || !borrower) throw new Error("enqueue: loan references are broken");

  const now = Date.now();
  const outboxId = await ctx.db.insert("outbox", {
    eventId: "",
    type,
    loanId,
    payload: "",
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
  });
  const eventId = `evt_${outboxId}`; // stable, unique, and the n8n-side dedupe key
  await ctx.db.patch(outboxId, {
    eventId,
    payload: buildPayload({ eventId, type, loan, toolName: tool.name, owner, borrower, reason, occurredAt: now }),
  });
  await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId });
  return outboxId;
}

export const get = internalQuery({
  args: { outboxId: v.id("outbox") },
  handler: (ctx, { outboxId }) => ctx.db.get(outboxId),
});

export const markDelivered = internalMutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status === "delivered") return;
    await ctx.db.patch(outboxId, {
      status: "delivered",
      attempts: row.attempts + 1,
      deliveredAt: Date.now(),
      lastError: undefined,
    });
  },
});

export const markFailedAttempt = internalMutation({
  args: { outboxId: v.id("outbox"), error: v.string() },
  handler: async (ctx, { outboxId, error }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "pending") return;
    const attempts = row.attempts + 1;
    const lastError = error.slice(0, 300);

    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(outboxId, { status: "dead", attempts, lastError });
      const key = `outbox:${outboxId}:${attempts}`;
      const exists = await ctx.db
        .query("automationFailures")
        .withIndex("by_key", (q) => q.eq("idempotencyKey", key))
        .unique();
      if (!exists) {
        await ctx.db.insert("automationFailures", {
          source: "convex",
          workflow: "Request notification (delivery to n8n)",
          message: `Gave up after ${attempts} attempts: ${lastError}`,
          idempotencyKey: key,
          outboxId,
        });
      }
      return;
    }

    const delay = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    await ctx.db.patch(outboxId, { attempts, lastError, nextAttemptAt: Date.now() + delay });
    await ctx.scheduler.runAfter(delay, internal.outbox.deliver, { outboxId });
  },
});

export const deliver = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.runQuery(internal.outbox.get, { outboxId });
    if (!row || row.status !== "pending") return;

    let error: string;
    try {
      const url = process.env.N8N_WEBHOOK_URL;
      if (!url) throw new Error("N8N_WEBHOOK_URL is not set");
      const { timestamp, signature } = await sign(secret("CONVEX_TO_N8N_SECRET"), PURPOSES.loanEvent, row.payload);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signature,
          "X-LendLoop-Event-Id": row.eventId,
        },
        body: row.payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        await ctx.runMutation(internal.outbox.markDelivered, { outboxId });
        return;
      }
      error = `n8n answered HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await ctx.runMutation(internal.outbox.markFailedAttempt, { outboxId, error });
  },
});

/**
 * Safety net (cron, every 10 minutes): re-dispatch any pending row whose
 * scheduled attempt should already have happened — e.g. after a deploy
 * interrupted a running action.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("outbox")
      .withIndex("by_status_next", (q) => q.eq("status", "pending").lt("nextAttemptAt", Date.now() - 5 * 60_000))
      .take(50);
    for (const row of stale) {
      await ctx.db.patch(row._id, { nextAttemptAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId: row._id });
    }
    return stale.length;
  },
});
