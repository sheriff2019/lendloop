import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";
import { PEOPLE } from "./people";

/**
 * Gets a Clerk testing token (skips bot protection in tests) and makes sure the
 * two test people exist in the Clerk DEVELOPMENT instance. Uses CLERK_SECRET_KEY
 * from .env.local; refuses to run against a production key.
 */

setup("clerk testing token + test users", async () => {
  const key = process.env.CLERK_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) throw new Error("E2E needs a Clerk DEVELOPMENT secret key (sk_test_…).");
  await clerkSetup();

  for (const p of Object.values(PEOPLE)) {
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const found = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(p.email)}`, { headers });
    if (((await found.json()) as unknown[]).length > 0) continue;
    const res = await fetch("https://api.clerk.com/v1/users", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email_address: [p.email],
        first_name: p.first,
        last_name: p.last,
        skip_password_requirement: true,
        skip_password_checks: true,
      }),
    });
    if (!res.ok) throw new Error(`Could not create ${p.email}: ${res.status} ${await res.text()}`);
  }
});
