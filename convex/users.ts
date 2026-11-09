import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getViewer } from "./lib/auth";
import { fail } from "./lib/domain";

/**
 * Called by the app right after sign-in. Creates or refreshes the caller's row
 * from the VERIFIED Clerk token. New users are always role "user"; there is no
 * argument a client could pass to become an admin.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail("UNAUTHENTICATED", "Please sign in first.");

    const email = (identity.email ?? "").trim().toLowerCase();
    const firstName =
      (identity.givenName ?? identity.name ?? email.split("@")[0] ?? "Neighbour").split(" ")[0].slice(0, 40) ||
      "Neighbour";
    const name = (identity.name ?? firstName).slice(0, 80);

    const existing = await getViewer(ctx);
    if (existing) {
      if (existing.name !== name || existing.firstName !== firstName || existing.email !== email) {
        await ctx.db.patch(existing._id, { name, firstName, email });
      }
      return existing._id;
    }
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      name,
      firstName,
      email,
      role: "user",
      trustedLender: false,
    });
  },
});

/** The signed-in person's own profile, for the header and role-aware navigation. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getViewer(ctx);
    if (!user) return null;
    return {
      _id: user._id,
      firstName: user.firstName,
      name: user.name,
      role: user.role,
      trustedLender: user.trustedLender,
    };
  },
});

/**
 * Make someone an admin. INTERNAL: callable only from the Convex dashboard or
 * CLI by whoever owns the deployment —
 *   npx convex run users:setRole '{"email":"you@example.com","role":"admin"}'
 */
export const setRole = internalMutation({
  args: { email: v.string(), role: v.union(v.literal("user"), v.literal("admin")) },
  handler: async (ctx, { email, role }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!user) throw new Error(`No user with email ${email}. They must sign in once first.`);
    await ctx.db.patch(user._id, { role });
    return `${user.name} is now ${role}.`;
  },
});
