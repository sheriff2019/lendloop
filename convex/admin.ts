import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/auth";
import { LIMITS, cleanText, fail, today } from "./lib/domain";
import { withdrawListing } from "./tools";
import { activityFor } from "./automation";

/**
 * Admin powers from the brief: remove any listing, view all loans, mark a
 * lender as Trusted. Every function starts with requireAdmin(ctx), so a normal
 * user calling them directly (not through the UI) gets FORBIDDEN.
 */

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const day = today();
    const loans = await ctx.db.query("loans").order("desc").take(300);
    const failures = await ctx.db
      .query("automationFailures")
      .withIndex("by_resolved", (q) => q.eq("resolvedAt", undefined))
      .order("desc")
      .take(50);
    // A dead outbox row always has its own automationFailures row, so failures covers both.
    const retrying = await ctx.db
      .query("outbox")
      .withIndex("by_status_next", (q) => q.eq("status", "pending"))
      .filter((q) => q.gt(q.field("attempts"), 0))
      .take(50);

    return {
      counts: {
        active: loans.filter((l) => l.status === "approved").length,
        overdue: loans.filter((l) => l.status === "approved" && l.endDate < day).length,
        pending: loans.filter((l) => l.status === "pending").length,
        failures: failures.length,
        retrying: retrying.length,
      },
      failures: failures.map((f) => ({
        _id: f._id,
        at: f._creationTime,
        source: f.source,
        workflow: f.workflow,
        node: f.node ?? null,
        message: f.message,
        executionId: f.executionId ?? null,
        outboxId: f.outboxId ?? null,
      })),
    };
  },
});

export const loans = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const day = today();
    const loans = await ctx.db.query("loans").order("desc").take(200);
    return await Promise.all(
      loans.map(async (l) => {
        const [tool, owner, borrower] = await Promise.all([
          ctx.db.get(l.toolId),
          ctx.db.get(l.ownerId),
          ctx.db.get(l.borrowerId),
        ]);
        const activity = await activityFor(ctx, l, "owner");
        return {
          _id: l._id,
          toolName: tool?.name ?? "Removed tool",
          ownerName: owner?.name ?? "Unknown",
          borrowerName: borrower?.name ?? "Unknown",
          startDate: l.startDate,
          endDate: l.endDate,
          status: l.status,
          overdue: l.status === "approved" && l.endDate < day,
          lastAutomation: activity.find((a) => a.tone !== "app") ?? null,
        };
      }),
    );
  },
});

export const lenders = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query("users").take(500);
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_removed", (q) => q.eq("removedAt", undefined))
      .take(2000);
    const loans = await ctx.db.query("loans").take(5000);
    return users
      .map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        trustedLender: u.trustedLender,
        tools: tools.filter((t) => t.ownerId === u._id).length,
        loansGiven: loans.filter((l) => l.ownerId === u._id && l.status === "returned").length,
      }))
      .sort((a, b) => b.tools - a.tools || a.name.localeCompare(b.name));
  },
});

export const listings = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_removed", (q) => q.eq("removedAt", undefined))
      .order("desc")
      .take(500);
    return await Promise.all(
      tools.map(async (t) => ({
        _id: t._id,
        name: t.name,
        category: t.category,
        description: t.description,
        ownerName: (await ctx.db.get(t.ownerId))?.name ?? "Unknown",
      })),
    );
  },
});

export const removeListing = mutation({
  args: { toolId: v.id("tools"), reason: v.string() },
  handler: async (ctx, { toolId, reason }) => {
    const admin = await requireAdmin(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.removedAt !== undefined) fail("NOT_FOUND", "That listing is already gone.");
    const why = cleanText(reason, "Reason", 3, LIMITS.removeReasonMax);
    await withdrawListing(ctx, toolId, admin._id, why, "listing_removed");
  },
});

export const setTrusted = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => {
    await requireAdmin(ctx);
    const user = await ctx.db.get(userId);
    if (!user) fail("NOT_FOUND", "That person no longer exists.");
    await ctx.db.patch(userId, { trustedLender: trusted });
  },
});

/** Mark a failure as looked at. It stays in the table for the record. */
export const resolveFailure = mutation({
  args: { failureId: v.id("automationFailures") },
  handler: async (ctx, { failureId }) => {
    const admin = await requireAdmin(ctx);
    const f = await ctx.db.get(failureId);
    if (!f || f.resolvedAt !== undefined) return;
    await ctx.db.patch(failureId, { resolvedAt: Date.now(), resolvedBy: admin._id });
  },
});

/** Give a dead outbox event a fresh set of attempts. */
export const retryDelivery = mutation({
  args: { failureId: v.id("automationFailures") },
  handler: async (ctx, { failureId }) => {
    const admin = await requireAdmin(ctx);
    const f = await ctx.db.get(failureId);
    if (!f?.outboxId) fail("CONFLICT", "Only a delivery to n8n can be retried from here. Re-run the workflow in n8n.");
    const row = await ctx.db.get(f.outboxId);
    if (!row || row.status !== "dead") fail("CONFLICT", "That delivery is not waiting for a retry.");
    await ctx.db.patch(row._id, { status: "pending", attempts: 0, nextAttemptAt: Date.now() });
    await ctx.db.patch(failureId, { resolvedAt: Date.now(), resolvedBy: admin._id });
    await ctx.scheduler.runAfter(0, internal.outbox.deliver, { outboxId: row._id });
  },
});
