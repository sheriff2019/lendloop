import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  categoryValidator,
  conditionValidator,
  loanStatusValidator,
  eventTypeValidator,
} from "./lib/domain";

export default defineSchema({
  // One row per person who has signed in. Copied from the Clerk identity on
  // sign-in; the role lives HERE (server-side) and is never read from the client.
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.string(),
    firstName: v.string(),
    email: v.string(),
    role: v.union(v.literal("user"), v.literal("admin")),
    trustedLender: v.boolean(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_email", ["email"]),

  tools: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    category: categoryValidator,
    condition: conditionValidator,
    description: v.string(),
    updatedAt: v.number(),
    // Soft delete: loans keep pointing at a real row, and admins keep an audit trail.
    removedAt: v.optional(v.number()),
    removedBy: v.optional(v.id("users")),
    removedReason: v.optional(v.string()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_removed", ["removedAt"]),

  loans: defineTable({
    toolId: v.id("tools"),
    ownerId: v.id("users"),
    borrowerId: v.id("users"),
    startDate: v.string(), // YYYY-MM-DD, a calendar day (no time zone games)
    endDate: v.string(),
    note: v.optional(v.string()),
    status: loanStatusValidator,
    decidedAt: v.optional(v.number()),
    returnedAt: v.optional(v.number()),
    closedReason: v.optional(v.string()),
  })
    .index("by_tool", ["toolId"])
    .index("by_owner", ["ownerId"])
    .index("by_borrower", ["borrowerId"])
    .index("by_status_end", ["status", "endDate"]),

  // Transactional outbox: a loan change and "tell n8n about it" are written in
  // the SAME mutation, so an event can never be lost or sent for a change that
  // rolled back. Delivery happens afterwards, with retries.
  outbox: defineTable({
    eventId: v.string(),
    type: eventTypeValidator,
    loanId: v.id("loans"),
    payload: v.string(), // the exact JSON body that is signed and sent
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("dead")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastError: v.optional(v.string()),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_event", ["eventId"])
    .index("by_status_next", ["status", "nextAttemptAt"])
    .index("by_loan", ["loanId"]),

  // What the automations did, per loan (shown as the loan's activity timeline).
  // idempotencyKey is unique by construction: every write checks it first
  // inside one serialisable mutation, so retries never create duplicates.
  automationEvents: defineTable({
    loanId: v.id("loans"),
    kind: v.union(v.literal("notification"), v.literal("reminder")),
    status: v.union(v.literal("sent"), v.literal("failed")),
    idempotencyKey: v.string(),
    eventType: v.optional(v.string()),
    detail: v.optional(v.string()),
    executionId: v.optional(v.string()),
  })
    .index("by_key", ["idempotencyKey"])
    .index("by_loan", ["loanId"]),

  // Failed automation runs, from n8n's error workflow or from the outbox giving up.
  automationFailures: defineTable({
    source: v.union(v.literal("n8n"), v.literal("convex")),
    workflow: v.string(),
    node: v.optional(v.string()),
    message: v.string(),
    executionId: v.optional(v.string()),
    idempotencyKey: v.string(),
    outboxId: v.optional(v.id("outbox")),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
  })
    .index("by_key", ["idempotencyKey"])
    .index("by_resolved", ["resolvedAt"]),
});
