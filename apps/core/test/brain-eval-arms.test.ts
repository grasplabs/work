import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageRecorded } from "../src/model-usage.ts";
import { answerAndJudge, bothArms } from "./brain-eval-arms.ts";
import { judgeSystem } from "./fixtures/brain-eval/everything.ts";
import { brainEvalSet } from "./fixtures/brain-eval/set.ts";
import { answeringProvider, testModel } from "./model-provider.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";
import { spentMicros } from "./model-usage.ts";

// The two arms of one question in the Brain evaluation against a model
// (brain-eval-arms.ts), through core's real model gateway to a scripted
// provider: nothing reaches a real model. One arm's provider refusing
// never ends the question before the other has answered and its spend is
// recorded, and the error names each arm that failed.

/** A question the set answers, so each arm is answered and judged. */
const question = brainEvalSet.questions.find(
  ({ expects }) => expects.kind === "answer"
);
if (question === undefined) {
  throw new Error("The set has no question with an answer");
}

/** What each arm is given: words a scripted provider tells them apart by. */
const contexts = { pack: "PACK-CONTEXT", everything: "EVERYTHING-CONTEXT" };

/** A provider refusing a request it can't take, as one would. */
const refused: ProviderReply = {
  status: 400,
  body: { error: { message: "The scripted provider refused it" } },
};

/**
 * A provider that refuses the arms in `refusing`, by what they were given,
 * and answers the rest, the judge with CORRECT.
 */
const scripted = async (refusing: readonly ("pack" | "everything")[]) =>
  await answeringProvider(
    (requests: readonly SentRequest[]): ProviderReply => {
      const body = JSON.stringify(requests.at(-1)?.body ?? "");
      if (refusing.some((arm) => body.includes(contexts[arm]))) {
        return refused;
      }
      return {
        text: body.includes(judgeSystem.slice(0, 40))
          ? "CORRECT"
          : "An answer.",
        inputTokens: 1000,
        outputTokens: 20,
      };
    },
    { models: [testModel] }
  );

/** Both arms of the question, through core's gateway. */
const arms = async () =>
  await bothArms(
    async () =>
      await answerAndJudge(
        env,
        testModel,
        question,
        "pack",
        contexts.pack,
        "p"
      ),
    async () =>
      await answerAndJudge(
        env,
        testModel,
        question,
        "everything",
        contexts.everything,
        "p"
      )
  );

/** What the gateway recorded as spent this month, once its records are written. */
const spentNow = async (): Promise<number> => {
  await usageRecorded();
  return await spentMicros(new Date().toISOString().slice(0, 7));
};

describe("a question's two arms", () => {
  it("ends only once the arm that answered was recorded, when the other's provider refuses, and names the one that failed", async () => {
    const provider = await scripted(["pack"]);
    const before = await spentNow();
    // The refused calls are logged as errors: that's what they are.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    let said = "";
    try {
      await arms();
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    logged.mockRestore();
    const spent = (await spentNow()) - before;
    const judged = provider.requests.filter(({ body }) =>
      JSON.stringify(body).includes(judgeSystem.slice(0, 40))
    ).length;

    expect({
      pack: said.includes("the pack arm failed"),
      everything: said.includes("the everything arm failed"),
      // The everything arm's answer and verdict, both recorded.
      judged,
      spent: spent > 0,
    }).toStrictEqual({ pack: true, everything: false, judged: 1, spent: true });
  });

  it("names both arms when both fail", async () => {
    await scripted(["pack", "everything"]);
    const logged = vi.spyOn(console, "error").mockReturnValue();
    let said = "";
    try {
      await arms();
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    logged.mockRestore();

    expect([
      said.includes("the pack arm failed"),
      said.includes("the everything arm failed"),
    ]).toStrictEqual([true, true]);
  });
});
