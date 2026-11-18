import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The Brain finds by meaning on the stack, as on a deployment: the stack
// runs the model core ships, its files put in the stack's model files
// bucket as it starts (scripts/local-model-files.ts). A person's upload
// is found by a search that shares no word with it. Without the model the
// search goes by words alone and finds nothing. How recall by meaning
// works, and what it may never show, is core's test
// (apps/core/test/brain-next-meaning.test.ts, the leak tests).

/**
 * How long the upload may take to be embedded: the person's own store
 * does its work on its own alarm, a minute after the upload, and its first
 * passage waits for the model to load (about 10 s on a laptop).
 */
const embedded = { timeout: 150_000, intervals: [2000] };

test("a person's upload is found by a search that shares no word with it, by meaning", async ({
  pageOf,
}) => {
  test.setTimeout(180_000);
  const { member } = peopleIn("brainMeaning");
  const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const passage = `Our office cat sleeps on the warm radiator every afternoon, ${tag}.`;
  const { core, api } = apiOf(member);
  try {
    await api.brainSources.upload(
      {
        name: `Office ${tag}.vtt`,
        bytes: new TextEncoder().encode(
          `WEBVTT\n\n00:00.000 --> 00:05.000\n${passage}\n`
        ),
      },
      { kind: "me" },
      crypto.randomUUID()
    );
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(member);
  await page.goto("/brain/sources");
  const box = page.getByRole("searchbox", { name: "Search the Brain" });
  const found = page
    .getByRole("button")
    .filter({ hasText: tag })
    .filter({ hasText: "By meaning" });
  // Asked again until its passage is embedded.
  await expect(async () => {
    await box.fill("Which pet naps near heating?");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
    await expect(found).toBeVisible({ timeout: 1000 });
  }).toPass(embedded);
});
