import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { modelScripts } from "./model-scripts.ts";
import { apiOf, peopleIn } from "./people.ts";

// The Agents page, for someone an agent answers: an admin makes an agent
// for everyone, a member finds it on their Agents page, opens a chat from
// its card with the agent mentioned, asks, and reads its answer. Making,
// changing and reaching an agent are core's tests
// (apps/core/test/agent-builder.test.ts, agent-reach.test.ts), and the
// pages' states are the frontend's (apps/web/src/agents).

test("a member finds an admin's agent on their Agents page, opens a chat with it from its card, and reads its answer", async ({
  pageOf,
}) => {
  const { admin, user } = peopleIn("agents");
  // Unique to the attempt: an agent's name is one of a kind.
  const name = `Ledger ${crypto.randomUUID().slice(0, 6)}`;
  const { core, api } = apiOf(admin);
  try {
    const made = await api.connections.makeAgent({
      name,
      face: "pen",
      job: "Answers questions about the weekly sales report.",
      modelRole: null,
    });
    await api.connections.setAgentReach(made.id, true, { who: "everyone" });
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(user);
  const { opener, replies } = modelScripts.answers;
  const [answer] = replies;
  const question = `${opener} (${crypto.randomUUID().slice(0, 8)})`;
  await page.goto("/agents");

  await page.getByLabel(`Chat with ${name}`).click();
  const box = page.getByLabel("Your question");
  await expect(box).toContainText(name);
  await box.click();
  await page.keyboard.type(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const messages = page.getByRole("log", { name: "Messages" });
  // Asked of the agent: its mention first, then the question.
  await expect(
    messages.getByRole("article", { name: "You" }).first()
  ).toContainText(`@${name} ${question}`);
  await expect(messages.getByText(answer.text)).toBeVisible({
    timeout: 30_000,
  });
  await expect(messages.getByRole("alert")).toHaveCount(0);
});
