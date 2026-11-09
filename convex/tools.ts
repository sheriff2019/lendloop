import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOwnTool, requireUser } from "./lib/auth";
import {
  CATEGORIES,
  LIMITS,
  categoryValidator,
  cleanText,
  conditionValidator,
  fail,
  today,
} from "./lib/domain";
import { enqueue } from "./outbox";

/**
 * PUBLIC page list. Deliberately returns ONLY name + category: no ids, no
 * owner, no description — nothing that identifies a neighbour to a visitor.
 */
export const publicList = query({
  args: {},
  handler: async (ctx) => {
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_removed", (q) => q.eq("removedAt", undefined))
      .take(500);
    return tools
      .map((t) => ({ name: t.name, category: t.category }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  },
});

type Availability =
  | { state: "available" }
  | { state: "on_loan"; until: string; overdue: boolean }
  | { state: "mine" };

async function liveLoans(ctx: QueryCtx, toolId: Id<"tools">) {
  const loans = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId))
    .collect();
  return loans.filter((l) => l.status === "approved" || l.status === "pending");
}

function availabilityOf(tool: Doc<"tools">, viewerId: Id<"users">, loans: Doc<"loans">[], day: string): Availability {
  if (tool.ownerId === viewerId) return { state: "mine" };
  const current = loans.find((l) => l.status === "approved" && l.startDate <= day);
  // An approved loan that started and is not returned holds the tool — even past its end date (overdue).
  return current
    ? { state: "on_loan", until: current.endDate, overdue: current.endDate < day }
    : { state: "available" };
}

/** Signed-in browse view: every listed tool with its availability. */
export const list = query({
  args: {
    category: v.optional(categoryValidator),
    availableOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { category, availableOnly }) => {
    const viewer = await requireUser(ctx);
    const day = today();
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_removed", (q) => q.eq("removedAt", undefined))
      .take(500);

    const rows = await Promise.all(
      tools
        .filter((t) => !category || t.category === category)
        .map(async (tool) => {
          const [owner, loans] = await Promise.all([ctx.db.get(tool.ownerId), liveLoans(ctx, tool._id)]);
          const availability = availabilityOf(tool, viewer._id, loans, day);
          return {
            _id: tool._id,
            name: tool.name,
            category: tool.category,
            condition: tool.condition,
            description: tool.description,
            // First name only: a borrower does not need more to ask.
            ownerFirstName: owner?.firstName ?? "A neighbour",
            ownerTrusted: owner?.trustedLender ?? false,
            isMine: tool.ownerId === viewer._id,
            availability,
            // Dates already promised to someone (no names), so the request form can refuse them up front.
            booked: loans
              .filter((l) => l.status === "approved" && l.endDate >= day)
              .map((l) => ({ start: l.startDate, end: l.endDate }))
              .sort((a, b) => a.start.localeCompare(b.start)),
            myOpenRequest: loans.some((l) => l.borrowerId === viewer._id && l.status === "pending"),
          };
        }),
    );

    return rows
      .filter((r) => !availableOnly || r.availability.state === "available")
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** "My listings": the caller's own tools, with what is happening to each. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireUser(ctx);
    const day = today();
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer._id))
      .collect();
    const live = tools.filter((t) => t.removedAt === undefined);
    return await Promise.all(
      live
        .sort((a, b) => b._creationTime - a._creationTime)
        .map(async (tool) => {
          const loans = await liveLoans(ctx, tool._id);
          const onLoan = loans.find((l) => l.status === "approved" && l.startDate <= day);
          return {
            _id: tool._id,
            name: tool.name,
            category: tool.category,
            condition: tool.condition,
            description: tool.description,
            pendingRequests: loans.filter((l) => l.status === "pending").length,
            onLoanUntil: onLoan?.endDate ?? null,
            overdue: onLoan ? onLoan.endDate < day : false,
            hasApprovedLoan: loans.some((l) => l.status === "approved"),
          };
        }),
    );
  },
});

export const categories = query({
  args: {},
  handler: () => [...CATEGORIES],
});

const toolFields = {
  name: v.string(),
  category: categoryValidator,
  condition: conditionValidator,
  description: v.string(),
};

function cleanTool(input: { name: string; description: string }) {
  return {
    name: cleanText(input.name, "Name", LIMITS.nameMin, LIMITS.nameMax),
    description: cleanText(input.description, "Description", 0, LIMITS.descriptionMax),
  };
}

export const create = mutation({
  args: toolFields,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const { name, description } = cleanTool(args);
    return await ctx.db.insert("tools", {
      ownerId: user._id,
      name,
      description,
      category: args.category,
      condition: args.condition,
      updatedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: { toolId: v.id("tools"), ...toolFields },
  handler: async (ctx, { toolId, ...args }) => {
    const user = await requireUser(ctx);
    await requireOwnTool(ctx, user, toolId);
    const { name, description } = cleanTool(args);
    await ctx.db.patch(toolId, {
      name,
      description,
      category: args.category,
      condition: args.condition,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Owner deletes their own listing. Refused while a loan is approved (the tool
 * is out, or promised). Pending requests are declined and their borrowers told.
 */
export const remove = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const user = await requireUser(ctx);
    await requireOwnTool(ctx, user, toolId);
    await withdrawListing(ctx, toolId, user._id, "Deleted by its owner", "listing_deleted");
  },
});

/** Shared by owner delete and admin removal. */
export async function withdrawListing(
  ctx: Parameters<typeof enqueue>[0],
  toolId: Id<"tools">,
  byUserId: Id<"users">,
  reason: string,
  eventReason: "listing_deleted" | "listing_removed",
) {
  const loans = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId))
    .collect();
  if (loans.some((l) => l.status === "approved")) {
    fail("CONFLICT", "This tool is lent out or promised. Mark it returned (or wait for the loan to end) first.");
  }
  const now = Date.now();
  for (const loan of loans.filter((l) => l.status === "pending")) {
    await ctx.db.patch(loan._id, { status: "declined", decidedAt: now, closedReason: eventReason });
    await enqueue(ctx, "loan.declined", loan._id, eventReason);
  }
  await ctx.db.patch(toolId, { removedAt: now, removedBy: byUserId, removedReason: reason });
}
