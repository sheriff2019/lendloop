/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { vi } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

export const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);

export const SECRETS = {
  CONVEX_TO_N8N_SECRET: "c".repeat(64),
  N8N_TO_CONVEX_SECRET: "n".repeat(64),
};

export function setup() {
  vi.stubEnv("CONVEX_TO_N8N_SECRET", SECRETS.CONVEX_TO_N8N_SECRET);
  vi.stubEnv("N8N_TO_CONVEX_SECRET", SECRETS.N8N_TO_CONVEX_SECRET);
  vi.stubEnv("N8N_WEBHOOK_URL", "https://n8n.test/webhook/lendloop-events");
  vi.stubEnv("APP_TIMEZONE", "UTC");
  return convexTest(schema, modules);
}

export type T = ReturnType<typeof setup>;

/** Signs in as a person and creates their users row (what the app does on first load). */
export async function person(t: T, key: string, opts: { admin?: boolean } = {}) {
  const as = t.withIdentity({
    tokenIdentifier: `https://clerk.test|${key}`,
    subject: key,
    issuer: "https://clerk.test",
    email: `${key}@example.com`,
    name: `${key[0].toUpperCase()}${key.slice(1)} Tester`,
    givenName: `${key[0].toUpperCase()}${key.slice(1)}`,
  });
  const id = await as.mutation(api.users.store, {});
  if (opts.admin) await t.run((ctx) => ctx.db.patch(id, { role: "admin" }));
  return { as, id };
}

export function day(offset: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Lets scheduled outbox deliveries run, against a stubbed fetch. */
export async function drainScheduled(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}
