import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { fail } from "./domain";

/**
 * Role-based access control. EVERY public query and mutation that touches
 * private data starts with one of these helpers — the UI hiding a button is a
 * convenience, never the control.
 *
 * Identity comes from the Clerk JWT that Convex verifies (convex/auth.config.ts);
 * the role comes from OUR users table, so a client cannot claim to be an admin.
 */

type Ctx = QueryCtx | MutationCtx;

export async function getViewer(ctx: Ctx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("UNAUTHENTICATED", "Please sign in first.");
  const user = await getViewer(ctx);
  // Signed in with Clerk but users.store has not run yet (first page load).
  if (!user) fail("UNAUTHENTICATED", "Your account is still being set up. Try again in a moment.");
  return user;
}

export async function requireAdmin(ctx: Ctx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.role !== "admin") fail("FORBIDDEN", "Only an admin can do that.");
  return user;
}

export function isAdmin(user: Doc<"users"> | null): boolean {
  return user?.role === "admin";
}

/** Loads a tool the caller owns. Admins do NOT pass this — admin powers are separate functions. */
export async function requireOwnTool(
  ctx: Ctx,
  user: Doc<"users">,
  toolId: Id<"tools">,
): Promise<Doc<"tools">> {
  const tool = await ctx.db.get(toolId);
  if (!tool || tool.removedAt !== undefined) fail("NOT_FOUND", "That tool no longer exists.");
  if (tool.ownerId !== user._id) fail("FORBIDDEN", "You can only change your own listings.");
  return tool;
}
