import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";

// An organization's Setup, as staff fill it in while its core is slow to
// answer: what they type is never overwritten by the answer that comes.

/** What the organizations seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({ answered: z.string() });

const seed = async (
  request: APIRequestContext
): Promise<z.infer<typeof seededSchema>> => {
  const response = await request.post("/__e2e/seed-organizations");
  expect(response.status()).toBe(200);
  return seededSchema.parse(await response.json());
};

/** What a seeded core answered so far, holding each answer `holdMs` from now on if given. */
const core = async (
  request: APIRequestContext,
  clientId: string,
  holdMs?: number
): Promise<number> => {
  const response = await request.post("/__e2e/core", {
    data: { clientId, holdMs },
  });
  expect(response.status()).toBe(200);
  return z.object({ reads: z.number() }).parse(await response.json()).reads;
};

test("what staff type in a Setup stays as its core's answer comes in", async ({
  page,
  request,
}) => {
  const { answered } = await seed(request);
  const settings = `/organizations/${answered}/setup?tab=settings`;
  // Once to warm what the page loads, then as staff open it, its core slow.
  await page.goto(settings, { waitUntil: "networkidle" });
  await core(request, answered, 2500);
  await page.goto(settings, { waitUntil: "commit" });
  const field = page.getByLabel("Entra tenant id");
  await expect(field).toBeVisible();
  // The Setup runs, and takes what is typed, before the answer is in.
  await page.waitForFunction(() => {
    const input = document.querySelector("#setup-sign-in-entra");
    return (
      input !== null &&
      Object.keys(input).some((key) => key.startsWith("__reactFiber"))
    );
  });
  await expect(page.getByText("Read just now.")).toHaveCount(0);
  await field.fill("typed-before-the-answer");

  await expect(page.getByText("Read just now.")).toBeVisible();
  await expect(field).toHaveValue("typed-before-the-answer");
  await core(request, answered, 0);
});
