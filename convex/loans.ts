import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isAdmin, requireUser } from "./lib/auth";
import {
  LIMITS,
  addDays,
  cleanText,
  daysBetween,
  fail,
  isDay,
  overlaps,
  today,
} from "./lib/domain";
import { enqueue } from "./outbox";
import { activityFor } from "./automation";

// ---------------------------------------------------------------------------
// Writes. Each one: who may do it → is the state right → change → enqueue the
// event for n8n, all in ONE transaction.
// ---------------------------------------------------------------------------

export const request = mutation({
  args: {
    toolId: v.id("tools"),
    startDate: v.string(),
    endDate: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { toolId, startDate, endDate, note }) => {
    const user = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.removedAt !== undefined) fail("NOT_FOUND", "That tool is no longer listed.");
    if (tool.ownerId === user._id) fail("FORBIDDEN", "You can't borrow your own tool.");

    if (!isDay(startDate) || !isDay(endDate)) fail("INVALID_INPUT", "Pick a start and an end date.");
    const day = today();
    if (startDate < day) fail("INVALID_INPUT", "The start date has already passed.");
    if (endDate < startDate) fail("INVALID_INPUT", "The end date is before the start date.");
    if (daysBetween(startDate, endDate) + 1 > LIMITS.loanMaxDays) {
      fail("INVALID_INPUT", `A loan can be at most ${LIMITS.loanMaxDays} days.`);
    }
    if (startDate > addDays(day, LIMITS.bookAheadDays)) {
      fail("INVALID_INPUT", `You can book up to ${LIMITS.bookAheadDays} days ahead.`);
    }

    const loans = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", toolId))
      .collect();
    if (loans.some((l) => l.status === "approved" && overlaps(l.startDate, l.endDate, startDate, endDate))) {
      fail("CONFLICT", "Those dates are already booked. Pick other dates.");
    }
    if (
      loans.some(
        (l) =>
          l.borrowerId === user._id &&
          l.status === "pending" &&
          overlaps(l.startDate, l.endDate, startDate, endDate),
      )
    ) {
      fail("CONFLICT", "You already asked for this tool on those dates.");
    }

    const open = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", user._id))
      .collect();
    if (open.filter((l) => l.status === "pending").length >= LIMITS.maxOpenRequestsPerBorrower) {
      fail("RATE_LIMITED", "You have too many requests waiting. Wait for answers or cancel some.");
    }

    const cleanNote = note ? cleanText(note, "Note", 0, LIMITS.noteMax) : "";
    const loanId = await ctx.db.insert("loans", {
      toolId,
      ownerId: tool.ownerId,
      borrowerId: user._id,
      startDate,
      endDate,
      ...(cleanNote ? { note: cleanNote } : {}),
      status: "pending",
    });
    await enqueue(ctx, "loan.requested", loanId);
    return loanId;
  },
});

async function loadLoan(ctx: MutationCtx, loanId: Id<"loans">): Promise<Doc<"loans">> {
  const loan = await ctx.db.get(loanId);
  if (!loan) fail("NOT_FOUND", "That request no longer exists.");
  return loan;
}

export const approve = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const user = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== user._id) fail("FORBIDDEN", "Only the tool's owner can approve.");
    if (loan.status !== "pending") fail("CONFLICT", `This request is already ${loan.status}.`);

    const tool = await ctx.db.get(loan.toolId);
    if (!tool || tool.removedAt !== undefined) fail("NOT_FOUND", "That tool is no longer listed.");
    if (loan.endDate < today()) fail("CONFLICT", "The requested dates have passed. Decline it instead.");

    const others = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", loan.toolId))
      .collect();
    const clash = (l: Doc<"loans">) =>
      l._id !== loan._id && overlaps(l.startDate, l.endDate, loan.startDate, loan.endDate);
    if (others.some((l) => l.status === "approved" && clash(l))) {
      fail("CONFLICT", "You already approved someone else for some of these dates.");
    }

    const now = Date.now();
    await ctx.db.patch(loanId, { status: "approved", decidedAt: now });
    await enqueue(ctx, "loan.approved", loanId);

    // The tool can't be in two places: overlapping requests are declined, and those borrowers told.
    for (const other of others.filter((l) => l.status === "pending" && clash(l))) {
      await ctx.db.patch(other._id, { status: "declined", decidedAt: now, closedReason: "dates_taken" });
      await enqueue(ctx, "loan.declined", other._id, "dates_taken");
    }
  },
});

export const decline = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const user = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== user._id) fail("FORBIDDEN", "Only the tool's owner can decline.");
    if (loan.status !== "pending") fail("CONFLICT", `This request is already ${loan.status}.`);
    await ctx.db.patch(loanId, { status: "declined", decidedAt: Date.now(), closedReason: "owner_declined" });
    await enqueue(ctx, "loan.declined", loanId);
  },
});

/** The borrower withdraws their own pending request. */
export const cancel = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const user = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.borrowerId !== user._id) fail("FORBIDDEN", "You can only cancel your own requests.");
    if (loan.status !== "pending") fail("CONFLICT", `This request is already ${loan.status}.`);
    await ctx.db.patch(loanId, { status: "cancelled", decidedAt: Date.now(), closedReason: "borrower_cancelled" });
    await enqueue(ctx, "loan.cancelled", loanId);
  },
});

/** The owner confirms the tool is back. Admins may also do this (e.g. a dispute). */
export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const user = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== user._id && !isAdmin(user)) {
      fail("FORBIDDEN", "Only the tool's owner can mark it returned.");
    }
    if (loan.status !== "approved") fail("CONFLICT", "Only an approved loan can be marked returned.");
    if (loan.startDate > today()) fail("CONFLICT", "This loan hasn't started yet, so there is nothing to return.");
    await ctx.db.patch(loanId, { status: "returned", returnedAt: Date.now() });
    await enqueue(ctx, "loan.returned", loanId);
  },
});

// ---------------------------------------------------------------------------
// Reads. Each view is scoped to the caller in the query itself.
// ---------------------------------------------------------------------------

async function present(ctx: QueryCtx, loan: Doc<"loans">, side: "owner" | "borrower", day: string) {
  const [tool, other] = await Promise.all([
    ctx.db.get(loan.toolId),
    ctx.db.get(side === "owner" ? loan.borrowerId : loan.ownerId),
  ]);
  return {
    _id: loan._id,
    _creationTime: loan._creationTime,
    toolName: tool?.name ?? "Removed tool",
    otherFirstName: other?.firstName ?? "A neighbour",
    startDate: loan.startDate,
    endDate: loan.endDate,
    note: loan.note ?? null,
    status: loan.status,
    closedReason: loan.closedReason ?? null,
    started: loan.startDate <= day,
    overdue: loan.status === "approved" && loan.endDate < day,
    activity: await activityFor(ctx, loan, side),
  };
}

/** Requests for MY tools, and my tools that are out. */
export const incoming = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const day = today();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .order("desc")
      .take(200);

    const pending = loans.filter((l) => l.status === "pending");
    const approved = loans.filter((l) => l.status === "approved");
    const closed = loans.filter((l) => l.status !== "pending" && l.status !== "approved").slice(0, 15);

    return {
      pending: await Promise.all(
        pending.map(async (l) => ({
          ...(await present(ctx, l, "owner", day)),
          // Other people waiting for overlapping dates — approving this declines them.
          competing: pending.filter(
            (o) => o._id !== l._id && o.toolId === l.toolId && overlaps(o.startDate, o.endDate, l.startDate, l.endDate),
          ).length,
          datesTaken: approved.some(
            (a) => a.toolId === l.toolId && overlaps(a.startDate, a.endDate, l.startDate, l.endDate),
          ),
          expired: l.endDate < day,
        })),
      ),
      out: await Promise.all(
        approved
          .sort((a, b) => a.endDate.localeCompare(b.endDate))
          .map((l) => present(ctx, l, "owner", day)),
      ),
      history: await Promise.all(closed.map((l) => present(ctx, l, "owner", day))),
    };
  },
});

/** Things I asked to borrow. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const day = today();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", user._id))
      .order("desc")
      .take(50);
    return await Promise.all(loans.map((l) => present(ctx, l, "borrower", day)));
  },
});

/** Badge counts for the navigation. */
export const counts = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const owned = await ctx.db
      .query("loans")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect();
    return { incomingPending: owned.filter((l) => l.status === "pending").length };
  },
});
