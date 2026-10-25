/**
 * The model provider of Stephen's eval in CI (GRA-720): a stand-in behind
 * AI Gateway, the one outside system the run mocks, as the Brain baseline's
 * is (brain-stub-model.ts). For each case it does what a careful Stephen
 * would: one code step that makes the case's connector calls and Knowledge
 * search through the agent's own `env`, then the case's answer, given only
 * once the evidence it rests on reached the model. So it measures whether
 * the platform got the right data to the model and held every change for
 * the person: not how well a model answers, which a real model's run
 * measures. A case built to break a hard rule hands it a turn that breaks
 * it instead (`StephenTurn.breaks`). As the judge it says a case passed
 * when the case's own checks held: a stand-in for the judge's verdict, so
 * the judge's path through the gateway and ledger is still run.
 */
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { normalized } from "./brain-scoring.ts";
import { modelStrings, resultsSinceQuestion } from "./brain-stub-model.ts";
import type {
  StephenCall,
  StephenCase,
  StephenContext,
} from "./fixtures/stephen-cases.ts";

/** Identifies the stub in a run's identity, as a model ID would. */
export const stephenStubModel = "stephen-stub-careful/2026-10-24";

/** A turn's own plan, as a case's stub gives it. */
export type StephenPlan = StephenCase["stub"];

/** What the harness is asking the model for right now. */
export type StephenTurn =
  | { phase: "idle" }
  | {
      phase: "case";
      item: StephenCase;
      context: StephenContext;
      /** A plan that breaks a hard rule, in place of the case's own. */
      breaks?: StephenPlan;
    }
  | {
      phase: "judge";
      item: StephenCase;
      /** Whether the case's own checks held: the stand-in's verdict. */
      checksHeld: boolean;
    };

/** A model provider: what it answers each gateway request with, in a turn. */
export type StephenProvider = (
  turn: () => StephenTurn
) => (
  requests: readonly GatewayRequest[]
) => GatewayReply | Promise<GatewayReply>;

/** The judge's verdict line, which the harness reads (stephen-harness.ts). */
export const verdictLine =
  /^\s*(?:\*\*)?\s*(?<verdict>PASS|FAIL)\b[:\s*-]*(?<reason>.*)$/imu;

/** Reads only, retried once: what a careful turn does when a read fails. */
const isRead = (action: string) =>
  /\.(?:list|get|listRows|thread)$/u.test(action);

/** Sections a Knowledge search reads. */
const searched = 5;

/** The code a turn's step runs: its calls in order, then its search. */
const stepCode = (
  calls: readonly StephenCall[],
  search?: string
): string => `export default async (self, env) => {
  const calls = ${JSON.stringify(calls.map((call) => ({ ...call, read: isRead(call.action) })))};
  const done = [];
  for (const { binding, action, input, read } of calls) {
    let result;
    for (let attempt = 0; attempt < (read ? 2 : 1); attempt += 1) {
      try {
        result = await env.connections.call(binding, action, input);
        break;
      } catch (error) {
        result = { error: String(error && error.message ? error.message : error) };
      }
    }
    done.push({ action, result });
  }
  const knowledge = [];
  const search = ${JSON.stringify(search ?? null)};
  if (search !== null) {
    const { hits } = await env.knowledge.search(search, { limit: ${searched} });
    for (const hit of hits) {
      const read = await env.knowledge.read(hit.documentId, { section: hit.section });
      knowledge.push({ documentId: hit.documentId, path: read.path, text: read.text });
    }
  }
  return { done, knowledge };
};`;

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

const codeStep = (code: string, input: string): GatewayReply => ({
  text: "",
  toolCalls: [
    {
      id: `call_${crypto.randomUUID()}`,
      name: "executeCode",
      arguments: { code },
    },
  ],
  inputTokens: tokensOf(input),
  outputTokens: tokensOf(code),
});

const says = (text: string, input: string): GatewayReply => ({
  text,
  inputTokens: tokensOf(input),
  outputTokens: tokensOf(text),
});

const returned = "Returned:\n";

/** The Knowledge sections a step's result handed the model. */
const knowledgeOf = (
  results: readonly string[]
): { documentId: string; path: string; text: string }[] =>
  results.flatMap((result) => {
    if (!result.startsWith(returned)) {
      return [];
    }
    try {
      const value: unknown = JSON.parse(result.slice(returned.length));
      return typeof value === "object" &&
        value !== null &&
        "knowledge" in value &&
        Array.isArray(value.knowledge)
        ? value.knowledge.flatMap((unit: unknown) =>
            typeof unit === "object" &&
            unit !== null &&
            "documentId" in unit &&
            "path" in unit &&
            "text" in unit
              ? [
                  {
                    documentId: String(unit.documentId),
                    path: String(unit.path),
                    text: String(unit.text),
                  },
                ]
              : []
          )
        : [];
    } catch {
      return [];
    }
  });

const couldNot = {
  en: "Sorry, I couldn't find that just now.",
  nl: "Sorry, dat kon ik nu niet vinden.",
} as const;

/**
 * The answer to a case given what reached the model, `results`: the plan's
 * answer once its evidence is there, citing the section that holds it.
 */
const answerOf = (
  item: StephenCase,
  plan: StephenPlan,
  context: StephenContext,
  results: readonly string[]
): string => {
  const seen = normalized(results.join("\n"));
  const evidence = plan.evidence?.(context) ?? [];
  if (!evidence.every((marker) => seen.includes(normalized(marker)))) {
    return couldNot[item.lang];
  }
  const [first] = evidence;
  const source = knowledgeOf(results).find(
    ({ text }) =>
      first !== undefined && normalized(text).includes(normalized(first))
  );
  const answer = plan.answer(context);
  return source === undefined
    ? answer
    : `${answer} [${source.path}](grasp:note/${source.documentId})`;
};

/** The stub provider: answers each request for the turn `current` says. */
export const stephenStub: StephenProvider = (current) => (requests) => {
  const body = requests.at(-1)?.body;
  const input = modelStrings(body).join("\n");
  const turn = current();
  if (turn.phase === "idle") {
    return says("Noted.", input);
  }
  if (turn.phase === "judge") {
    return says(
      turn.checksHeld
        ? "PASS: it does what the rubric asks."
        : "FAIL: it misses what the rubric asks.",
      input
    );
  }
  const plan = turn.breaks ?? turn.item.stub;
  const results = resultsSinceQuestion(body);
  const calls = plan.calls?.(turn.context) ?? [];
  if (results.length === 0 && (calls.length > 0 || plan.search !== undefined)) {
    return codeStep(stepCode(calls, plan.search), input);
  }
  return says(answerOf(turn.item, plan, turn.context, results), input);
};
