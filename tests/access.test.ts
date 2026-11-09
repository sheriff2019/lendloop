import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { day, person, setup } from "./setup";

/**
 * Role-based access control is enforced in Convex functions, not the UI.
 * Every refusal here calls the function DIRECTLY, the way a tampered client
 * would, and checks the error code — next to a positive control.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 202 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const drill = {
  name: "Cordless drill",
  category: "Power tools" as const,
  condition: "Good" as const,
  description: "Two batteries.",
};

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { data?: { code?: string } }).data?.code ?? String(e);
  }
}

describe("public page", () => {
  test("lists only name and category — no ids, owners or descriptions", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    await ama.as.mutation(api.tools.create, drill);
    const list = await t.query(api.tools.publicList, {});
    expect(list).toEqual([{ name: "Cordless drill", category: "Power tools" }]);
  });

  test("removed listings are not shown", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const id = await ama.as.mutation(api.tools.create, drill);
    await ama.as.mutation(api.tools.remove, { toolId: id });
    expect(await t.query(api.tools.publicList, {})).toEqual([]);
  });
});

describe("signed-out callers", () => {
  test("cannot read the signed-in views or write anything", async () => {
    const t = setup();
    expect(await code(t.query(api.tools.list, {}))).toBe("UNAUTHENTICATED");
    expect(await code(t.query(api.loans.incoming, {}))).toBe("UNAUTHENTICATED");
    expect(await code(t.mutation(api.tools.create, drill))).toBe("UNAUTHENTICATED");
  });
});

describe("users act only on their own listings and requests", () => {
  test("a user cannot edit or delete someone else's listing", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const ben = await person(t, "ben");
    const toolId = await ama.as.mutation(api.tools.create, drill);

    expect(await code(ben.as.mutation(api.tools.update, { toolId, ...drill, name: "Mine now" }))).toBe("FORBIDDEN");
    expect(await code(ben.as.mutation(api.tools.remove, { toolId }))).toBe("FORBIDDEN");
    // positive control
    expect(await code(ama.as.mutation(api.tools.update, { toolId, ...drill, name: "Drill (18V)" }))).toBe("OK");
  });

  test("only the owner can approve, decline or mark returned; only the borrower can cancel", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const ben = await person(t, "ben");
    const eve = await person(t, "eve");
    const toolId = await ama.as.mutation(api.tools.create, drill);
    const loanId = await ben.as.mutation(api.loans.request, { toolId, startDate: day(0), endDate: day(2) });

    expect(await code(eve.as.mutation(api.loans.approve, { loanId }))).toBe("FORBIDDEN");
    expect(await code(ben.as.mutation(api.loans.approve, { loanId }))).toBe("FORBIDDEN"); // borrower can't self-approve
    expect(await code(eve.as.mutation(api.loans.decline, { loanId }))).toBe("FORBIDDEN");
    expect(await code(ama.as.mutation(api.loans.cancel, { loanId }))).toBe("FORBIDDEN");
    expect(await code(eve.as.mutation(api.loans.cancel, { loanId }))).toBe("FORBIDDEN");

    expect(await code(ama.as.mutation(api.loans.approve, { loanId }))).toBe("OK");
    expect(await code(eve.as.mutation(api.loans.markReturned, { loanId }))).toBe("FORBIDDEN");
    expect(await code(ben.as.mutation(api.loans.markReturned, { loanId }))).toBe("FORBIDDEN");
    expect(await code(ama.as.mutation(api.loans.markReturned, { loanId }))).toBe("OK");
  });

  test("each view shows only the caller's own loans", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const ben = await person(t, "ben");
    const eve = await person(t, "eve");
    const toolId = await ama.as.mutation(api.tools.create, drill);
    await ben.as.mutation(api.loans.request, { toolId, startDate: day(0), endDate: day(1) });

    expect((await ama.as.query(api.loans.incoming, {})).pending).toHaveLength(1);
    expect(await ben.as.query(api.loans.mine, {})).toHaveLength(1);
    expect((await eve.as.query(api.loans.incoming, {})).pending).toHaveLength(0);
    expect(await eve.as.query(api.loans.mine, {})).toHaveLength(0);
  });
});

describe("admin powers", () => {
  test("a normal user calling admin functions directly is refused", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const toolId = await ama.as.mutation(api.tools.create, drill);
    expect(await code(ama.as.query(api.admin.loans, {}))).toBe("FORBIDDEN");
    expect(await code(ama.as.query(api.admin.overview, {}))).toBe("FORBIDDEN");
    expect(await code(ama.as.mutation(api.admin.removeListing, { toolId, reason: "test" }))).toBe("FORBIDDEN");
    expect(await code(ama.as.mutation(api.admin.setTrusted, { userId: ama.id, trusted: true }))).toBe("FORBIDDEN");
  });

  test("an admin can view all loans, remove any listing and mark a Trusted Lender", async () => {
    const t = setup();
    const admin = await person(t, "root", { admin: true });
    const ama = await person(t, "ama");
    const ben = await person(t, "ben");
    const toolId = await ama.as.mutation(api.tools.create, drill);
    await ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(2) });

    expect(await admin.as.query(api.admin.loans, {})).toHaveLength(1);

    await admin.as.mutation(api.admin.setTrusted, { userId: ama.id, trusted: true });
    const seen = await ben.as.query(api.tools.list, {});
    expect(seen[0].ownerTrusted).toBe(true);

    await admin.as.mutation(api.admin.removeListing, { toolId, reason: "Duplicate listing" });
    expect(await t.query(api.tools.publicList, {})).toEqual([]);
    // the pending request was declined, not left hanging
    const [loan] = await ben.as.query(api.loans.mine, {});
    expect(loan.status).toBe("declined");
    expect(loan.closedReason).toBe("listing_removed");
  });

  test("nobody can make themselves admin: new users are always 'user'", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const me = await ama.as.query(api.users.me, {});
    expect(me?.role).toBe("user");
  });
});
