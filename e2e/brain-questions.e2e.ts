import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The brain's questions on their notes, for the company's admins: one that
// needs no answer is closed without one, and an answer is redacted, with
// who gave it, the question staying closed. Each is asked first. A member
// is offered neither. Who may, and what each changes, is core's test
// (apps/core/test/brain-records.test.ts).

/** How long a page of the brain may take to read the brain. */
const brainRead = { timeout: 15_000 };

test("an admin closes a question without an answer and redacts another's answer, which a member can't", async ({
  pageOf,
}) => {
  const { admin, member } = peopleIn("brainQuestions");
  const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const unanswered = `gap-${tag}-open`;
  const answered = `gap-${tag}-answered`;
  const answer = `About ${tag} invoices a month.`;
  const mine = apiOf(admin);
  const theirs = apiOf(member);
  try {
    await mine.api.brain.addRecords([
      {
        type: "source",
        id: `src-${tag}`,
        kind: "document",
        title: "Finance notes",
        date: "2026-10-20",
        who: "Head of finance",
      },
      {
        type: "gap",
        id: unanswered,
        question: `Who approves a refund ${tag}?`,
        owner: "Head of finance",
        sourceId: `src-${tag}`,
      },
      {
        type: "gap",
        id: answered,
        question: `How many invoices come in ${tag}?`,
        owner: "Head of finance",
        sourceId: `src-${tag}`,
      },
    ]);
    await theirs.api.brain.answerGap(answered, answer);
  } finally {
    mine.core[Symbol.dispose]();
    theirs.core[Symbol.dispose]();
  }

  const reader = await pageOf(member);
  await reader.goto(`/brain/${answered}`);
  // The answer is among the note's details, which fold beside a narrow page.
  await expect(reader.getByText(answer).first()).toBeAttached(brainRead);
  await expect(
    reader.getByRole("button", { name: "Redact the answer" })
  ).toHaveCount(0);
  await reader.goto(`/brain/${unanswered}`);
  await expect(reader.getByRole("heading", { level: 1 })).toBeVisible(
    brainRead
  );
  await expect(
    reader.getByRole("button", { name: "Close without an answer" })
  ).toHaveCount(0);

  const page = await pageOf(admin);
  await page.goto(`/brain/${answered}`);
  await expect(page.getByText(answer).first()).toBeAttached(brainRead);
  await page.getByRole("button", { name: "Redact the answer" }).click();
  await page.getByRole("button", { name: "Redact it" }).click();
  await expect(page.getByText(answer)).toHaveCount(0, brainRead);
  await expect(
    page.getByRole("button", { name: "Redact the answer" })
  ).toHaveCount(0);

  await page.goto(`/brain/${unanswered}`);
  await page.getByRole("button", { name: "Close without an answer" }).click();
  await page.getByRole("button", { name: "Close it" }).click();
  await expect(
    page.getByRole("button", { name: "Close without an answer" })
  ).toHaveCount(0, brainRead);
});
