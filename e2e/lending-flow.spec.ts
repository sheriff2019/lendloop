import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { PEOPLE } from "./people";

/**
 * The whole lending loop in a real browser, as two different people:
 * public page → lender lists a tool → borrower requests it → lender approves
 * (overlapping request auto-declined) → lender marks it returned.
 * When Mailpit is running, the n8n emails are checked too.
 */

const TOOL = `E2E ladder ${Date.now().toString(36)}`;
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: email });
  return page;
}

async function mailpitUp() {
  try {
    return (await fetch(`${MAILPIT}/api/v1/messages?limit=1`)).ok;
  } catch {
    return false;
  }
}

async function waitForEmail(to: string, subjectPart: string) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const data = (await res.json()) as { messages: { Subject: string }[] };
    const hit = data.messages.find((m) => m.Subject.includes(subjectPart));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No email to ${to} containing "${subjectPart}"`);
}

test.describe.configure({ mode: "serial" });

test("public page: tagline, read-only list without owners, and the Clerk sign-in button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Borrow what you need/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in to lend or borrow" }).first()).toBeVisible();
  const list = page.getByRole("region", { name: "Tools in the neighbourhood" });
  await expect(list).toBeVisible();
  await expect(list).not.toContainText("Lent by");
});

test("signed-out visitors are sent to sign in", async ({ page }) => {
  await page.goto("/requests");
  await expect(page).not.toHaveURL(/\/requests$/);
});

test("lend → request → approve → return, by two different people", async ({ browser }) => {
  const lender = await signedIn(browser, PEOPLE.lender.email);
  const borrower = await signedIn(browser, PEOPLE.borrower.email);

  // Lender lists a tool.
  await lender.goto("/listings");
  await lender.getByLabel("Name").fill(TOOL);
  await lender.getByLabel("Category").selectOption("Ladders");
  await lender.getByLabel("Condition").selectOption("Good");
  await lender.getByLabel("Short description").fill("Five metres, sturdy feet.");
  await lender.getByRole("button", { name: "Publish listing" }).click();
  await expect(lender.getByRole("status")).toContainText(`“${TOOL}” is listed`);
  await expect(lender.getByRole("region", { name: "Your tools" })).toContainText(TOOL);

  // Borrower finds it and asks for it.
  await borrower.goto("/tools");
  // A normal user has no Admin link (the page itself is refused below).
  await expect(borrower.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Admin" })).toHaveCount(0);
  await borrower.getByRole("button", { name: new RegExp(TOOL) }).click();
  const details = borrower.getByRole("complementary", { name: "Tool details" });
  await expect(details).toContainText("Lent by Lola");
  await expect(details).not.toContainText("Lender"); // first name only
  await details.getByLabel(/Note to Lola/).fill("For clearing the gutters");
  await details.getByRole("button", { name: /Send request/ }).click();
  await expect(details.getByRole("status")).toContainText("Request sent");

  // It shows under the borrower's own requests.
  await borrower.goto("/requests?tab=mine");
  await expect(borrower.getByText(`${TOOL} from Lola`)).toBeVisible();

  // Lender approves it.
  await lender.goto("/requests");
  const card = lender.locator("div", { hasText: `Bayo wants your ${TOOL}` }).filter({ has: lender.getByRole("button", { name: "Approve" }) }).last();
  await expect(card).toContainText("For clearing the gutters");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(lender.getByText(`Bayo wants your ${TOOL}`)).toHaveCount(0);

  // It is now lent out; the borrower sees it approved.
  await lender.getByRole("tab", { name: /Lent out/ }).click();
  const out = lender.locator("div", { hasText: `${TOOL} · with Bayo` }).filter({ has: lender.getByRole("button", { name: "Mark as returned" }) }).last();
  await expect(out).toBeVisible();
  await borrower.reload();
  await expect(borrower.getByText("Approved").first()).toBeVisible();

  if (await mailpitUp()) {
    await waitForEmail(PEOPLE.lender.email, `would like to borrow your ${TOOL}`);
    await waitForEmail(PEOPLE.borrower.email, `You can borrow the ${TOOL}`);
    // The loan's timeline shows what the automation did.
    await lender.reload();
    await lender.getByRole("tab", { name: /Lent out/ }).click();
    await expect(out.getByText(/Email sent to Bayo/)).toBeVisible({ timeout: 20_000 });
  }

  // Lender marks it returned (allowed once the loan has started — it starts today).
  await out.getByRole("button", { name: "Mark as returned" }).click();
  await lender.getByRole("tab", { name: "History" }).click();
  await expect(lender.getByText(`${TOOL} · Bayo`)).toBeVisible();
});

test("the admin page refuses a normal user", async ({ browser }) => {
  const page = await signedIn(browser, PEOPLE.borrower.email);
  await page.goto("/admin");
  await expect(page.getByText("Admins only")).toBeVisible();
});
