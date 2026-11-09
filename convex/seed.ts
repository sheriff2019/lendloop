import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { Category, Condition } from "./lib/domain";
import { addDays, today } from "./lib/domain";

/**
 * Demo data so the public page and the overdue workflow have something to show.
 * INTERNAL — run it yourself:   npx convex run seed:demo
 * Remove it again:               npx convex run seed:clear
 * Demo neighbours cannot sign in (their token ids are not real Clerk ids) and
 * use @example.com addresses, which locally land in Mailpit.
 */

const NEIGHBOURS = [
  { key: "ama", name: "Ama Mensah", trusted: true },
  { key: "kofi", name: "Kofi Boateng", trusted: false },
  { key: "lena", name: "Lena Fischer", trusted: true },
  { key: "tomi", name: "Tomi Adeyemi", trusted: false },
] as const;

const TOOLS: { owner: string; name: string; category: Category; condition: Condition; description: string }[] = [
  { owner: "ama", name: "Cordless drill (18V)", category: "Power tools", condition: "Good", description: "Two batteries and a charger. Please bring it back charged." },
  { owner: "ama", name: "Camping stove", category: "Camping", condition: "Like new", description: "Single burner, gas canister not included." },
  { owner: "kofi", name: "Hedge trimmer", category: "Garden", condition: "Good", description: "Electric, 10 m cable." },
  { owner: "kofi", name: "Socket set", category: "Hand tools", condition: "Fair", description: "Metric, a couple of sizes missing." },
  { owner: "lena", name: "4-person tent", category: "Camping", condition: "Fair", description: "Dry and packed, one pole slightly bent." },
  { owner: "lena", name: "Stand mixer", category: "Kitchen", condition: "Good", description: "With dough hook and whisk." },
  { owner: "tomi", name: "Pressure washer", category: "Cleaning", condition: "Good", description: "Patio cleaner head included." },
  { owner: "tomi", name: "Extension ladder (5 m)", category: "Ladders", condition: "Worn", description: "Sturdy, but the feet are worn." },
];

const DEMO_PREFIX = "demo|";

export const demo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", `${DEMO_PREFIX}ama`))
      .unique();
    if (existing) return "Demo data is already there.";

    const ids: Record<string, Id<"users">> = {};
    for (const n of NEIGHBOURS) {
      ids[n.key] = await ctx.db.insert("users", {
        tokenIdentifier: `${DEMO_PREFIX}${n.key}`,
        name: n.name,
        firstName: n.name.split(" ")[0],
        email: `${n.key}@example.com`,
        role: "user",
        trustedLender: n.trusted,
      });
    }
    const toolIds: Record<string, Id<"tools">> = {};
    for (const t of TOOLS) {
      toolIds[t.name] = await ctx.db.insert("tools", {
        ownerId: ids[t.owner],
        name: t.name,
        category: t.category,
        condition: t.condition,
        description: t.description,
        updatedAt: Date.now(),
      });
    }

    const day = today();
    // Overdue: Tomi borrowed Ama's stove and it was due back two days ago.
    await ctx.db.insert("loans", {
      toolId: toolIds["Camping stove"],
      ownerId: ids.ama,
      borrowerId: ids.tomi,
      startDate: addDays(day, -6),
      endDate: addDays(day, -2),
      status: "approved",
      decidedAt: Date.now() - 7 * 86_400_000,
    });
    // On loan now: Lena has Kofi's hedge trimmer.
    await ctx.db.insert("loans", {
      toolId: toolIds["Hedge trimmer"],
      ownerId: ids.kofi,
      borrowerId: ids.lena,
      startDate: addDays(day, -1),
      endDate: addDays(day, 3),
      status: "approved",
      decidedAt: Date.now() - 2 * 86_400_000,
    });
    return `Added ${NEIGHBOURS.length} neighbours, ${TOOLS.length} tools and 2 loans (one overdue).`;
  },
});

async function deleteLoan(ctx: MutationCtx, loanId: Id<"loans">) {
  for (const e of await ctx.db.query("automationEvents").withIndex("by_loan", (q) => q.eq("loanId", loanId)).collect()) {
    await ctx.db.delete(e._id);
  }
  for (const o of await ctx.db.query("outbox").withIndex("by_loan", (q) => q.eq("loanId", loanId)).collect()) {
    await ctx.db.delete(o._id);
  }
  await ctx.db.delete(loanId);
}

export const clear = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = (await ctx.db.query("users").take(1000)).filter((u) => u.tokenIdentifier.startsWith(DEMO_PREFIX));
    for (const u of users) {
      for (const t of await ctx.db.query("tools").withIndex("by_owner", (q) => q.eq("ownerId", u._id)).collect()) {
        for (const l of await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", t._id)).collect()) {
          await deleteLoan(ctx, l._id);
        }
        await ctx.db.delete(t._id);
      }
      for (const l of await ctx.db.query("loans").withIndex("by_borrower", (q) => q.eq("borrowerId", u._id)).collect()) {
        await deleteLoan(ctx, l._id);
      }
      await ctx.db.delete(u._id);
    }
    return `Removed ${users.length} demo neighbours and their tools and loans.`;
  },
});
