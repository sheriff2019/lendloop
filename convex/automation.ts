import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { addDays, daysBetween, isDay, today } from "./lib/domain";
import { MAX_ATTEMPTS } from "./outbox";

/**
 * Everything n8n reads from or writes to Convex goes through these INTERNAL
 * functions, reachable only via the signed HTTP routes in http.ts.
 * Every write is idempotent: it looks up its key first, inside one
 * serialisable transaction, so a retried request never creates a second row.
 */

const RECIPIENT_IS_OWNER: Record<string, boolean> = {
  "loan.requested": true,
  "loan.cancelled": true,
};

export type ActivityItem = { at: number; text: string; tone: "app" | "auto" | "warn" };

/** A loan's timeline: what people did, and what the automations did. Newest first. */
export async function activityFor(
  ctx: QueryCtx,
  loan: Doc<"loans">,
  side: "owner" | "borrower",
): Promise<ActivityItem[]> {
  const [owner, borrower] = await Promise.all([ctx.db.get(loan.ownerId), ctx.db.get(loan.borrowerId)]);
  const name = (who: "owner" | "borrower") =>
    who === side ? "you" : ((who === "owner" ? owner : borrower)?.firstName ?? "a neighbour");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const items: ActivityItem[] = [
    { at: loan._creationTime, text: `${cap(name("borrower"))} asked to borrow it`, tone: "app" },
  ];
  if (loan.decidedAt !== undefined) {
    const verb =
      loan.status === "cancelled"
        ? `${cap(name("borrower"))} cancelled the request`
        : loan.closedReason === "dates_taken"
          ? "Declined automatically: the dates went to someone else"
          : loan.closedReason === "listing_deleted" || loan.closedReason === "listing_removed"
            ? "Declined automatically: the listing was removed"
            : loan.status === "declined"
              ? `${cap(name("owner"))} declined`
              : `${cap(name("owner"))} approved`;
    items.push({ at: loan.decidedAt, text: verb, tone: "app" });
  }
  if (loan.returnedAt !== undefined) {
    items.push({ at: loan.returnedAt, text: "Marked as returned", tone: "app" });
  }

  const events = await ctx.db
    .query("automationEvents")
    .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
    .collect();
  for (const e of events) {
    if (e.kind === "notification") {
      const to = name(RECIPIENT_IS_OWNER[e.eventType ?? ""] ? "owner" : "borrower");
      items.push(
        e.status === "sent"
          ? { at: e._creationTime, text: `Email sent to ${to}`, tone: "auto" }
          : { at: e._creationTime, text: `Email to ${to} failed`, tone: "warn" },
      );
    } else {
      const to = name("borrower");
      items.push(
        e.status === "sent"
          ? { at: e._creationTime, text: `Overdue reminder sent to ${to}`, tone: "auto" }
          : { at: e._creationTime, text: `Overdue reminder to ${to} failed`, tone: "warn" },
      );
    }
  }

  const outbox = await ctx.db
    .query("outbox")
    .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
    .collect();
  for (const o of outbox) {
    if (o.status === "dead") {
      items.push({ at: o._creationTime, text: "A notification could not be delivered (admin alerted)", tone: "warn" });
    } else if (o.status === "pending" && o.attempts > 0) {
      items.push({
        at: o._creationTime,
        text: `Notification delayed, retrying (${o.attempts} of ${MAX_ATTEMPTS})`,
        tone: "warn",
      });
    }
  }

  return items.sort((a, b) => b.at - a.at).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Workflow 2 — overdue reminders
// ---------------------------------------------------------------------------

export const overdueList = internalQuery({
  args: {},
  handler: async (ctx) => {
    const day = today();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_status_end", (q) => q.eq("status", "approved").lt("endDate", day))
      .take(500);

    const out = [];
    for (const loan of loans) {
      const done = await ctx.db
        .query("automationEvents")
        .withIndex("by_key", (q) => q.eq("idempotencyKey", reminderKey(loan._id, day)))
        .unique();
      if (done?.status === "sent") continue; // already reminded today
      const [borrower, owner, tool] = await Promise.all([
        ctx.db.get(loan.borrowerId),
        ctx.db.get(loan.ownerId),
        ctx.db.get(loan.toolId),
      ]);
      if (!borrower?.email) continue;
      // Only what the reminder email needs.
      out.push({
        loanId: loan._id,
        firstName: borrower.firstName,
        email: borrower.email,
        toolName: tool?.name ?? "the tool",
        ownerFirstName: owner?.firstName ?? "its owner",
        dueDate: loan.endDate,
        daysOverdue: daysBetween(loan.endDate, day),
      });
    }
    return { day, loans: out };
  },
});

export function reminderKey(loanId: string, day: string) {
  return `reminder:${loanId}:${day}`;
}

export const recordReminder = internalMutation({
  args: {
    loanId: v.string(),
    day: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed")),
    error: v.optional(v.string()),
    executionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ result: "created" | "updated" | "duplicate" } | { error: string }> => {
    const loanId = ctx.db.normalizeId("loans", args.loanId);
    if (!loanId) return { error: "unknown loan" };
    const loan = await ctx.db.get(loanId);
    if (!loan) return { error: "unknown loan" };
    // The day must be "today" give or take one (n8n and Convex may sit either side of midnight).
    const now = today();
    if (!isDay(args.day) || args.day < addDays(now, -1) || args.day > addDays(now, 1)) {
      return { error: "day out of range" };
    }

    const key = reminderKey(loanId, args.day);
    const existing = await ctx.db
      .query("automationEvents")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", key))
      .unique();
    if (existing) {
      // A retry of the same result is a no-op. A later success may replace an earlier failure.
      if (existing.status === "failed" && args.status === "sent") {
        await ctx.db.patch(existing._id, { status: "sent", detail: undefined, executionId: args.executionId });
        return { result: "updated" };
      }
      return { result: "duplicate" };
    }
    await ctx.db.insert("automationEvents", {
      loanId,
      kind: "reminder",
      status: args.status,
      idempotencyKey: key,
      detail: args.error?.slice(0, 300),
      executionId: args.executionId,
    });
    return { result: "created" };
  },
});

// ---------------------------------------------------------------------------
// Workflow 1 — notification results
// ---------------------------------------------------------------------------

export const recordNotification = internalMutation({
  args: {
    eventId: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed")),
    error: v.optional(v.string()),
    executionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ result: "created" | "updated" | "duplicate" } | { error: string }> => {
    const row = await ctx.db
      .query("outbox")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (!row) return { error: "unknown event" };

    const key = `notify:${args.eventId}`;
    const existing = await ctx.db
      .query("automationEvents")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", key))
      .unique();
    if (existing) {
      if (existing.status === "failed" && args.status === "sent") {
        await ctx.db.patch(existing._id, { status: "sent", detail: undefined, executionId: args.executionId });
        return { result: "updated" };
      }
      return { result: "duplicate" };
    }
    await ctx.db.insert("automationEvents", {
      loanId: row.loanId,
      kind: "notification",
      status: args.status,
      idempotencyKey: key,
      eventType: row.type,
      detail: args.error?.slice(0, 300),
      executionId: args.executionId,
    });
    return { result: "created" };
  },
});

// ---------------------------------------------------------------------------
// Workflow 3 — error workflow
// ---------------------------------------------------------------------------

export const recordFailure = internalMutation({
  args: {
    workflow: v.string(),
    node: v.optional(v.string()),
    message: v.string(),
    executionId: v.string(),
  },
  handler: async (ctx, args): Promise<{ result: "created" | "duplicate" }> => {
    const key = `n8n:${args.executionId}`;
    const existing = await ctx.db
      .query("automationFailures")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", key))
      .unique();
    if (existing) return { result: "duplicate" };
    await ctx.db.insert("automationFailures", {
      source: "n8n",
      workflow: args.workflow.slice(0, 120),
      node: args.node?.slice(0, 120),
      message: args.message.slice(0, 500),
      executionId: args.executionId.slice(0, 64),
      idempotencyKey: key,
    });
    return { result: "created" };
  },
});
