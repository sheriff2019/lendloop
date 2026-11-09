import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { api } from "../convex/_generated/api";
import { MAX_ATTEMPTS } from "../convex/outbox";
import { SECRETS, day, drainScheduled, person, setup, type T } from "./setup";

/** Signs like n8n does: HMAC-SHA256 over "<ts>.<purpose>.<body>". */
function signed(purpose: string, body: string, opts: { secret?: string; ts?: number } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRETS.N8N_TO_CONVEX_SECRET)
    .update(`${ts}.${purpose}.${body}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-LendLoop-Timestamp": ts,
    "X-LendLoop-Signature": `v1=${sig}`,
  };
}

async function overdueLoan(t: T) {
  const ama = await person(t, "ama");
  const ben = await person(t, "ben");
  const toolId = await ama.as.mutation(api.tools.create, {
    name: "Camping stove",
    category: "Camping",
    condition: "Good",
    description: "",
  });
  // Insert directly: the request rules (rightly) refuse dates in the past.
  const loanId = await t.run((ctx) =>
    ctx.db.insert("loans", {
      toolId,
      ownerId: ama.id,
      borrowerId: ben.id,
      startDate: day(-5),
      endDate: day(-2),
      status: "approved",
      decidedAt: Date.now(),
    }),
  );
  return { ama, ben, loanId };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => new Response("ok", { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("signed n8n → Convex endpoints", () => {
  test("refuse unsigned, wrong-secret, wrong-purpose and stale requests", async () => {
    const t = setup();
    await overdueLoan(t);
    const get = (headers: Record<string, string>) => t.fetch("/n8n/overdue", { method: "GET", headers });

    expect((await get({})).status).toBe(401);
    expect((await get(signed("overdue-list", "", { secret: "x".repeat(64) }))).status).toBe(401);
    expect((await get(signed("reminder-result", ""))).status).toBe(401); // signature for another endpoint
    expect((await get(signed("overdue-list", "", { ts: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);

    const ok = await get(signed("overdue-list", ""));
    expect(ok.status).toBe(200);
  });

  test("overdue list holds only the fields the reminder needs", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const res = await t.fetch("/n8n/overdue", { method: "GET", headers: signed("overdue-list", "") });
    const body = await res.json();
    expect(body.loans).toEqual([
      {
        loanId,
        firstName: "Ben",
        email: "ben@example.com",
        toolName: "Camping stove",
        ownerFirstName: "Ama",
        dueDate: day(-2),
        daysOverdue: 2,
      },
    ]);
  });

  test("a tampered body fails verification", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const body = JSON.stringify({ loanId, day: day(0), status: "sent" });
    const res = await t.fetch("/n8n/reminders", {
      method: "POST",
      headers: signed("reminder-result", body),
      body: body.replace("sent", "failed"),
    });
    expect(res.status).toBe(401);
  });
});

describe("idempotent write-backs", () => {
  test("the same reminder result twice makes ONE record, and the loan leaves today's list", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const body = JSON.stringify({ loanId, day: day(0), status: "sent", executionId: "41" });
    const post = () => t.fetch("/n8n/reminders", { method: "POST", headers: signed("reminder-result", body), body });

    expect(await (await post()).json()).toEqual({ result: "created" });
    expect(await (await post()).json()).toEqual({ result: "duplicate" });
    const rows = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(rows).toHaveLength(1);

    const list = await (await t.fetch("/n8n/overdue", { method: "GET", headers: signed("overdue-list", "") })).json();
    expect(list.loans).toEqual([]);
  });

  test("a later success replaces a failure for the same day; it never goes back", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const send = async (status: string) => {
      const body = JSON.stringify({ loanId, day: day(0), status });
      return (await t.fetch("/n8n/reminders", { method: "POST", headers: signed("reminder-result", body), body })).json();
    };
    expect(await send("failed")).toEqual({ result: "created" });
    expect(await send("sent")).toEqual({ result: "updated" });
    expect(await send("failed")).toEqual({ result: "duplicate" });
    const [row] = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(row.status).toBe("sent");
  });

  test("failures from the error workflow are recorded once per execution", async () => {
    const t = setup();
    const body = JSON.stringify({ workflow: "Overdue reminders", node: "Send reminder", message: "SMTP down", executionId: "77" });
    const post = () => t.fetch("/n8n/failures", { method: "POST", headers: signed("workflow-failure", body), body });
    await post();
    await post();
    const rows = await t.run((ctx) => ctx.db.query("automationFailures").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("SMTP down");
  });
});

describe("Convex → n8n delivery (outbox)", () => {
  test("delivers once, signed so n8n can verify it", async () => {
    const t = setup();
    const ama = await person(t, "ama");
    const ben = await person(t, "ben");
    const toolId = await ama.as.mutation(api.tools.create, {
      name: "Drill",
      category: "Power tools",
      condition: "Good",
      description: "",
    });
    await ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(2) });
    await drainScheduled(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://n8n.test/webhook/lendloop-events");
    const headers = init.headers as Record<string, string>;
    const expected = createHmac("sha256", SECRETS.CONVEX_TO_N8N_SECRET)
      .update(`${headers["X-LendLoop-Timestamp"]}.loan-event.${init.body}`)
      .digest("hex");
    expect(headers["X-LendLoop-Signature"]).toBe(`v1=${expected}`);

    const [row] = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(row.status).toBe("delivered");
  });

  test("retries with backoff, then gives up visibly: dead row + admin-visible failure", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const t = setup();
    const ama = await person(t, "ama");
    const ben = await person(t, "ben");
    const toolId = await ama.as.mutation(api.tools.create, {
      name: "Drill",
      category: "Power tools",
      condition: "Good",
      description: "",
    });
    const loanId = await ben.as.mutation(api.loans.request, { toolId, startDate: day(1), endDate: day(2) });
    await drainScheduled(t);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const [row] = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(row.status).toBe("dead");
    expect(row.lastError).toContain("503");
    const failures = await t.run((ctx) => ctx.db.query("automationFailures").collect());
    expect(failures).toHaveLength(1);
    expect(failures[0].source).toBe("convex");

    // The owner sees it on the loan's timeline, not just the admin.
    const { pending } = await ama.as.query(api.loans.incoming, {});
    expect(pending.find((p) => p._id === loanId)?.activity.some((a) => a.tone === "warn")).toBe(true);

    // An admin can give it another go once n8n is back.
    fetchMock.mockImplementation(async () => new Response("ok", { status: 202 }));
    const admin = await person(t, "root", { admin: true });
    await admin.as.mutation(api.admin.retryDelivery, { failureId: failures[0]._id });
    await drainScheduled(t);
    const [after] = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(after.status).toBe("delivered");
  });
});
