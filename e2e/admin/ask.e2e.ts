import { expect, test } from "@playwright/test";

// Ask Grasp in the admin: staff start from one of its questions, which
// asks it at once. Who answers, and how, is the admin's tests'
// (apps/admin/test/admin-ask.test.ts).

test("staff start Ask Grasp from one of its questions", async ({
  page,
  request,
}) => {
  // The admin's database, with no client: asking reads none.
  const seeded = await request.post("/__e2e/seed-create");
  expect(seeded.status()).toBe(200);
  await page.goto("/ask", { waitUntil: "networkidle" });
  const questions = page.getByRole("list", { name: "Questions to start from" });
  const first = questions.getByRole("button").first();
  const question = (await first.textContent()) ?? "";
  expect(question).not.toBe("");

  await first.click();
  await expect(
    page
      .getByRole("list", { name: "The conversation" })
      .getByRole("listitem")
      .first()
  ).toHaveText(question);
});
