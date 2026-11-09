import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { day, person, setup, type T } from "./setup";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 202 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { data?: { code?: string } }).data?.code ?? String(e);
  }
}

async function world(t: T) {
  const ama = await person(t, "ama");
  const ben = await person(t, "ben");
  const kemi = await person(t, "kemi");
  const toolId = await ama.as.mutation(api.tools.create, {
    name: "Cordless drill",
    category: "Power tools",
    condition: "Good",
    description: "",
  });
  return { ama, ben, kemi, toolId };
}

describe("listing a tool", () => {
  test("validates on the server, whatever the form did", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const base = { category: "Garden" as const, condition: "Good" as const, description: "" };
    expect(await code(ama.as.mutation(api.tools.create, { ...base, name: " " }))).toBe("INVALID_INPUT");
    expect(await code(ama.as.mutation(api.tools.create, { ...base, name: "x".repeat(61) }))).toBe("INVALID_INPUT");
    expect(await code(ama.as.mutation(api.tools.create, { ...base, name: "Rake", description: "y".repeat(281) }))).toBe(
      "INVALID_INPUT",
    );
    // @ts-expect-error — a category outside the list is rejected by the validator
    expect(await code(ama.as.mutation(api.tools.create, { ...base, name: "Rake", category: "Weapons" }))).not.toBe("OK");
  });
});

describe("requesting a loan", () => {
  test("refuses your own tool, past dates, reversed or too-long ranges", async () => {
    const t = setup();
    const { ama, ben, toolId } = await world(t);
    expect(await code(ama.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(2) }))).toBe("FORBIDDEN");
    expect(await code(ben.as.mutation(api.loans.request, { toolId, startDate: day(-1), endDate: day(2) }))).toBe("INVALID_INPUT");
    expect(await code(ben.as.mutation(api.loans.request, { toolId, startDate: day(3), endDate: day(2) }))).toBe("INVALID_INPUT");
    expect(await code(ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(40) }))).toBe("INVALID_INPUT");
    expect(await code(ben.as.mutation(api.loans.request, { toolId, startDate: "2026-02-30", endDate: day(2) }))).toBe(
      "INVALID_INPUT",
    );
    expect(await code(ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(2) }))).toBe("OK");
    // asking twice for the same dates is refused
    expect(await code(ben.as.mutation(api.loans.request, { toolId, startDate: day(2), endDate: day(3) }))).toBe("CONFLICT");
  });

  test("dates already approved for someone else cannot be requested", async () => {
    const t = setup();
    const { ama, ben, kemi, toolId } = await world(t);
    const loanId = await ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(4) });
    await ama.as.mutation(api.loans.approve, { loanId });
    expect(await code(kemi.as.mutation(api.loans.request, { toolId, startDate: day(4), endDate: day(6) }))).toBe("CONFLICT");
    expect(await code(kemi.as.mutation(api.loans.request, { toolId, startDate: day(5), endDate: day(6) }))).toBe("OK");
  });
});

describe("approving", () => {
  test("declines overlapping requests automatically, and tells those borrowers", async () => {
    const t = setup();
    const { ama, ben, kemi, toolId } = await world(t);
    const bens = await ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(3) });
    await kemi.as.mutation(api.loans.request, { toolId, startDate: day(2), endDate: day(2) });

    const pending = (await ama.as.query(api.loans.incoming, {})).pending;
    expect(pending.find((p) => p._id === bens)?.competing).toBe(1);

    await ama.as.mutation(api.loans.approve, { loanId: bens });
    const [kemis] = await kemi.as.query(api.loans.mine, {});
    expect(kemis.status).toBe("declined");
    expect(kemis.closedReason).toBe("dates_taken");

    const events = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(events.map((e) => e.type).sort()).toEqual([
      "loan.approved",
      "loan.declined",
      "loan.requested",
      "loan.requested",
    ]);
    const declined = JSON.parse(events.find((e) => e.type === "loan.declined")!.payload);
    expect(declined.recipient.email).toBe("kemi@example.com");
    expect(declined.reason).toBe("dates_taken");
  });

  test("cannot approve twice, or approve a cancelled request", async () => {
    const t = setup();
    const { ama, ben, toolId } = await world(t);
    const loanId = await ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(2) });
    await ben.as.mutation(api.loans.cancel, { loanId });
    expect(await code(ama.as.mutation(api.loans.approve, { loanId }))).toBe("CONFLICT");
  });
});

describe("returning and deleting", () => {
  test("a lent-out tool cannot be deleted; after return it can", async () => {
    const t = setup();
    const { ama, ben, toolId } = await world(t);
    const loanId = await ben.as.mutation(api.loans.request, { toolId, startDate: day(0), endDate: day(2) });
    await ama.as.mutation(api.loans.approve, { loanId });

    const browse = await ben.as.query(api.tools.list, {});
    expect(browse[0].availability).toEqual({ state: "on_loan", until: day(2), overdue: false });

    expect(await code(ama.as.mutation(api.tools.remove, { toolId }))).toBe("CONFLICT");
    await ama.as.mutation(api.loans.markReturned, { loanId });
    expect((await ben.as.query(api.tools.list, {}))[0].availability).toEqual({ state: "available" });
    expect(await code(ama.as.mutation(api.tools.remove, { toolId }))).toBe("OK");
  });
});

describe("events for n8n carry only what the email needs", () => {
  test("payload: first names, recipient email, tool name, dates — nothing else", async () => {
    const t = setup();
    const { ben, toolId } = await world(t);
    await ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(2), note: "private note" });
    const [row] = await t.run((ctx) => ctx.db.query("outbox").collect());
    const body = JSON.parse(row.payload);
    expect(Object.keys(body).sort()).toEqual(
      ["dates", "eventId", "loanId", "occurredAt", "otherParty", "recipient", "tool", "type"].sort(),
    );
    expect(body.recipient).toEqual({ firstName: "Ama", email: "ama@example.com" });
    expect(body.otherParty).toEqual({ firstName: "Ben" }); // no borrower email or surname
    expect(row.payload).not.toContain("private note");
    expect(row.payload).not.toContain("ben@example.com");
  });
});
