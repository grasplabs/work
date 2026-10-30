import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// A source's transcript on its note's page: a person uploads a meeting's
// captions to Knowledge, and opens the source they became in the brain,
// where its turns read in order. Which documents become sources, and who
// may read their turns, is core's test (apps/core/test/brain-transcripts.test.ts).

/** How long an upload's text extraction, and a page of the brain, may take. */
const ready = { timeout: 30_000 };

const captions = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Anna>Welcome all, let's start with the budget.

00:00:07.000 --> 00:00:12.000
<v Grasp>What takes the longest each month?

00:01:03.000 --> 00:01:05.000
<v Anna>Copying invoices by hand.
`;

test("a person opens the source an uploaded meeting became in the brain, and reads its transcript", async ({
  pageOf,
}) => {
  const { member } = peopleIn("brainTranscript");
  const { core, api } = apiOf(member);
  let collectionId: string;
  try {
    ({ id: collectionId } = await api.knowledge.createCollection({
      name: `Meetings ${crypto.randomUUID()}`,
      access: "me",
    }));
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(member);
  await page.goto(`/knowledge/${collectionId}`);
  const uploads = page.getByRole("region", { name: "Upload" });
  await uploads.getByLabel("Upload a PDF, Word or Excel file").setInputFiles({
    name: "budget-meeting.vtt",
    mimeType: "text/vtt",
    buffer: Buffer.from(captions),
  });
  const row = uploads
    .getByRole("listitem")
    .filter({ hasText: "budget-meeting.vtt" });
  await expect(row.getByRole("status")).toHaveText("Ready", ready);
  const href = await row
    .getByRole("link", { name: "Open budget-meeting.vtt" })
    .getAttribute("href");
  const documentId = new URL(href ?? "", "http://grasp.test").searchParams.get(
    "doc"
  );
  expect(documentId).not.toBeNull();

  await page.goto(`/brain/src.knowledge-${documentId}`);
  await expect(page.getByText("Copying invoices by hand.")).toBeVisible(ready);
  await expect(
    page.getByText("What takes the longest each month?")
  ).toBeVisible();
});
