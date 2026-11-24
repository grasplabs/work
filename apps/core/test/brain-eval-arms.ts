import { models } from "../src/models.ts";
import type { BrainEvalQuestion } from "./fixtures/brain-eval/company.ts";
import {
  answerInput,
  answerSystem,
  judgeInput,
  judgeSystem,
  judgedCorrect,
  outputTokensMax,
  saidNotFound,
} from "./fixtures/brain-eval/everything.ts";

// One question's two arms in the Brain evaluation against a model
// (GRA-1813, brain-eval-model.test.ts): each answered through core's model
// gateway, as any of core's calls, and judged; and both settled before a
// failure of either is thrown, so a run never ends while a call it started
// still spends. Apart from the opt-in run so it is tested with a scripted
// provider (brain-eval-arms.test.ts).

/** Which arm a call is for. */
export type Arm = "pack" | "everything";

/** An arm's answer, judged, and what its calls used. */
export interface ArmResult {
  correct: boolean;
  leaks: string[];
  inputTokens: number;
  outputTokens: number;
}

/** One answer from `model` through core's gateway: its text and the tokens it used. */
const ask = async (
  env: Env,
  model: string,
  purpose: string,
  system: string,
  input: string
): Promise<{ text: string; input: number; output: number }> => {
  const { text, usage } = await models(env).call({
    model,
    system,
    input,
    purpose,
    trigger: { type: "system" },
    work: { platform: "brain_upkeep" },
    maxTokens: outputTokensMax,
  });
  return { text, input: usage.inputTokens, output: usage.outputTokens };
};

/** Secrets of `question` that `text` holds. */
const leaksIn = (question: BrainEvalQuestion, text: string): string[] =>
  question.expects.kind === "hidden"
    ? question.expects.secrets.filter((secret) => text.includes(secret))
    : [];

/** One arm's answer to `question` from `context`, judged against `passage`. */
export const answerAndJudge = async (
  env: Env,
  model: string,
  question: BrainEvalQuestion,
  arm: Arm,
  context: string,
  passage: string
): Promise<ArmResult> => {
  const answered = await ask(
    env,
    model,
    `brain.eval.${arm}`,
    answerSystem,
    answerInput(question.question, context)
  );
  const leaks = leaksIn(question, answered.text);
  let correct = saidNotFound(answered.text) && leaks.length === 0;
  let { input } = answered;
  let { output } = answered;
  if (question.expects.kind === "answer") {
    const verdict = await ask(
      env,
      model,
      "brain.eval.judge",
      judgeSystem,
      judgeInput(question.question, passage, answered.text)
    );
    correct = judgedCorrect(verdict.text);
    input += verdict.input;
    output += verdict.output;
  }
  return { correct, leaks, inputTokens: input, outputTokens: output };
};

/** What an arm's failure said, for the error that names it. */
const messageOf = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

/**
 * Both arms, run side by side and settled: their results once both
 * answered. When either failed, throws once both have settled, naming each
 * arm that failed, so what the other spent is counted before the run ends.
 */
export const bothArms = async (
  pack: () => Promise<ArmResult>,
  everything: () => Promise<ArmResult>
): Promise<{ pack: ArmResult; everything: ArmResult }> => {
  const [packed, given] = await Promise.allSettled([pack(), everything()]);
  if (packed.status === "fulfilled" && given.status === "fulfilled") {
    return { pack: packed.value, everything: given.value };
  }
  const failed = [
    ...(packed.status === "rejected"
      ? [`the pack arm failed: ${messageOf(packed.reason)}`]
      : []),
    ...(given.status === "rejected"
      ? [`the everything arm failed: ${messageOf(given.reason)}`]
      : []),
  ];
  throw new Error(failed.join("; "));
};
