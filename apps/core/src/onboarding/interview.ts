import type {
  AssistantMessage,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import {
  answerOf,
  checkedTurn,
  earlyNext,
  earlyOpening,
  earlyPlainLine,
  fileCalled,
  interviewTurnMaxBytes,
  interviewTurnRequestSchema,
  notesSchema,
  onlyLine,
  onlyNotes,
  plainLine,
  turnLinesMax,
  waitsForMore,
} from "@grasp-os/shared/interview-turn";
import type {
  InterviewEvent,
  InterviewTurnRequest,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { interviewerNames } from "@grasp-os/shared/onboarding";

import { errorResponse } from "../errors.ts";
import { gatewaySettings, modelForRole, models } from "../models.ts";
import type { ModelCall, ModelsEnv } from "../models.ts";
import { readOrganization } from "../organization.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { interviewerText } from "./interviewer-text.ts";
import { linkHeaders, linkRefusal } from "./links.ts";
import { onboardingStore } from "./store.ts";
import type { Took, TurnContext } from "./store.ts";

// One turn of someone's interview, `POST /api/interview/turn`, on their own
// link: Stephen's next line as soon as it is written, and what he writes
// down from what was just said. Two models through the model gateway, side
// by side: the deployment's quick one says his line, in plain named lines,
// because whoever he talks to is waiting for it; its careful one writes
// down what was said, as checked JSON, once his line is out, because
// nobody waits for that and it is what the interview is for. Ported from
// the prototype (grasplabs/prototype, packages/grasp: worker/interview.ts).
//
// What it must not do, from the threat model (GRA-307), and what stops it:
//
// - Let the page say who it is or what Stephen knows: the link's secret
//   and the device's key are checked by the store, and who they are, their
//   team, their lead and what Stephen knows come from it (`turnContext`).
//   The page sends only the conversation, which it holds.
// - Tell the company who talked, and when: every gateway call is made by
//   the system for `onboarding.interview`, never in anyone's name, and
//   onboarding calls always count as carrying sensitive data
//   (model-rules.ts), so only models the rules allow for that are used.
// - Let a line out that breaks his rules: it is put right before it goes
//   (`asStephenSays`), and a fact whose words weren't said is left out
//   (`checkedTurn`).
// - Run up the bill: the body is bounded, the store limits calls per link,
//   the conversation sent is its last lines, and a turn given up halfway
//   is cut off at once, and still counted for what it took.

/** What the gateway is told every call of an interview is for. */
const purpose = "onboarding.interview";

/** The most the line's model writes: six short lines. */
const lineTokens = 400;
/** The most the notes' model writes: the facts of one answer. */
const notesTokens = 4000;

/** What happened, as Stephen is told it, for someone called `name`. */
const happenedOf = (
  turn: InterviewTurnRequest,
  name: string
): Record<InterviewEvent, string> => {
  const last = turn.lines.at(-1);
  return {
    start: `The interview starts now. ${name} has just pressed start. Say your first line.`,
    answer:
      last?.typed === true
        ? `${name} typed their answer.`
        : `${name} answered out loud; it is written as speech recognition heard it.`,
    resume: `${name} left and has just come back. Say in one short sentence where you were, then ask what comes next.`,
    file: `${name} shared a file. You see only what it is called, not what kind of file it is or what is in it. Speak of it by that name with the word for a file, as "the workflow file"; never say a file ending such as pdf. Say in a few words what you see, thank them, and ask whether it is a normal one or a difficult one.`,
    nudge: `${name} stopped mid-sentence and has stayed quiet since. Answer with what there is.`,
    readback: `You read these lines back to ${name}: ${(turn.reading ?? []).join(", ")}. Their last line is their answer to that.`,
    add: `${name} agreed to the read-back earlier and has just come back on their link to add something. Ask what they would like to add or put right.`,
  };
};

/** The first part takes 3 minutes at most: a talker can fill the whole interview with it. */
const aiPartMinutes = 3;

/**
 * What Stephen is told for one turn: who he talks to and about what, what
 * Grasp knows already, what he wrote down, the conversation, and what just
 * happened. Who they are comes from the store, the conversation from the
 * page.
 */
export const briefOf = (
  turn: InterviewTurnRequest,
  context: TurnContext,
  company: string
): string => {
  const { name, team, lead, work, kind, known } = context;
  const self = interviewerNames[turn.interviewer];
  const lines = turn.lines.slice(-turnLinesMax);
  const toLearn =
    work === ""
      ? "The work to learn about: not named yet. In part 3, ask which work comes back most often or takes most of their time, and learn that one."
      : `The work to learn about: ${work}.`;
  const teamLead =
    lead === null
      ? ' You do not know who their team lead is: say "I was told" instead.'
      : ` Their team lead, who pointed you to them: ${lead}.`;
  return [
    `The company: ${company === "" ? "the company" : company}.`,
    kind === "lead"
      ? `You talk with: ${name}, who leads ${team === "" ? "the team" : team}. This is the interview about the work of the whole team.`
      : `You talk with: ${name}${team === "" ? "" : `, ${team}`}.${teamLead}`,
    kind === "lead"
      ? "The work to learn about: everything the team does, and who does which."
      : toLearn,
    ...(known === "" ? [] : ["", "What Grasp knows already:", known]),
    `Minutes since they pressed start: ${turn.minutes.toFixed(1)}. The part you were in: ${turn.phase}.`,
    ...(turn.phase === "you" && turn.minutes > aiPartMinutes
      ? [
          "Part 2 has taken more than 3 minutes. When you have not asked what they wish for, ask only that now. When you have, your next line starts part 3: say that you now go to the work.",
        ]
      : []),
    ...(turn.adding
      ? [
          "They agreed to everything you wrote down before, and are back to add something: stay with that, then read back only what is new.",
        ]
      : []),
    "",
    "What you wrote down so far:",
    turn.facts.length === 0
      ? "(nothing yet)"
      : turn.facts
          .map((fact) => `- [${fact.id}] ${fact.tag}: ${fact.text}`)
          .join("\n"),
    "",
    "The conversation so far:",
    lines.length === 0
      ? "(nothing yet)"
      : lines
          .map(
            (line) =>
              `${line.from === "stephen" ? self : name}: ${answerOf(line.text)}${line.file === undefined ? "" : ` [shared a file called "${fileCalled(line.file)}"]`}`
          )
          .join("\n"),
    "",
    `What just happened: ${happenedOf(turn, name)[turn.event]}`,
  ].join("\n");
};

/** Why a turn went wrong, as the page is told it. */
class TurnFailedError extends Error {
  override name = "TurnFailedError";
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

const lostThread = () =>
  new TurnFailedError("Stephen lost his thread. Say it once more.", 502);

/** The gateway's own refusals, as the stream ends with them (models.ts). */
const gatewayRefusal = /^The model call was refused \((?<code>[a-z_.]+)\)/u;

/** What a gateway refusal tells the page: busy is worth a retry, the rest isn't. */
const refusalOf = (code: string | undefined): TurnFailedError =>
  code === "model.budget_busy" || code === "model.rate_limited"
    ? new TurnFailedError("Stephen is busy. Try again in a minute.", 429)
    : new TurnFailedError("Stephen could not be reached. Try again.", 502);

/** The text a finished answer holds; it throws when there is none to use. */
const textOfAnswer = (answer: AssistantMessage): string => {
  const text = answer.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  if (answer.stopReason === "error" || answer.stopReason === "aborted") {
    const code = gatewayRefusal.exec(answer.errorMessage ?? "")?.groups?.code;
    throw code === undefined
      ? new TurnFailedError(
          "Stephen could not answer that. Say it another way.",
          502,
          {
            cause: "declined",
          }
        )
      : refusalOf(code);
  }
  if (text.trim() === "" || answer.stopReason === "length") {
    throw lostThread();
  }
  return text;
};

/** What one call took, as the onboarding counts it. */
const tookOf = (
  model: string,
  usage: AssistantMessage["usage"] | undefined
): Took | null =>
  usage === undefined
    ? null
    : {
        purpose: "interviews",
        model,
        tokensIn: usage.input + usage.cacheRead + usage.cacheWrite,
        tokensCached: usage.cacheRead,
        tokensOut: usage.output,
      };

interface Turn {
  env: ModelsEnv & Env;
  turn: InterviewTurnRequest;
  context: TurnContext;
  system: string;
  brief: string;
  quick: string;
  careful: string;
  signal: AbortSignal;
  send: (event: TurnEvent) => void;
  count: (took: Took | null) => void;
}

const session = (model: string) =>
  ({
    model,
    purpose,
    trigger: { type: "system" },
    work: { onboarding: true },
    effort: "low",
  }) as const;

/** Streams the line's model; `onText` sees everything written so far. */
const speak = async (
  { env, system, brief, signal, count }: Turn,
  model: string,
  onText: (written: string) => void
): Promise<string> => {
  const agent = await models(env).agent({
    ...session(model),
    maxTokens: lineTokens,
  });
  const stream: AssistantMessageEventStream = agent.stream(
    agent.model,
    normalizeContext({
      systemPrompt: system,
      messages: [
        {
          role: "user",
          content: `${brief}\n\n${onlyLine}`,
          timestamp: Date.now(),
        },
      ],
    }),
    { signal }
  );
  let written = "";
  for await (const event of stream) {
    if (event.type === "text_delta") {
      written += event.delta;
      onText(written);
    }
  }
  const answer = await stream.result();
  count(tookOf(model, answer.usage));
  return textOfAnswer(answer);
};

/** Asks the notes' model what to write down from what was just said. */
const write = async (
  { env, system, brief, signal, count }: Turn,
  model: string
): Promise<unknown> => {
  const call: ModelCall<unknown> = {
    ...session(model),
    system,
    input: `${brief}\n\n${onlyNotes}`,
    schema: notesSchema,
    maxTokens: notesTokens,
    signal,
  };
  try {
    const { output, usage } = await models(env).call(call);
    count({
      purpose: "interviews",
      model,
      tokensIn: usage.inputTokens,
      tokensCached: usage.cacheRead,
      tokensOut: usage.outputTokens,
    });
    return output;
  } catch (error) {
    const code = modelErrors.codeOf(error);
    throw code === undefined ? lostThread() : refusalOf(code);
  }
};

/** A promise's outcome, kept to be looked at later: started early, it never goes unhandled. */
type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

const settled = async (promise: Promise<unknown>): Promise<Settled> => {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
};

/** For a line nobody hears as it is written: the one asked again. */
const unheard = (): void => undefined;

/**
 * One turn: the line as soon as it is written (its first short sentence
 * even sooner, then where the interview goes), what was written down once
 * the line is out, then the whole turn checked. A line the model declines
 * is asked once more of the careful one; anything else that fails is the
 * page's to try again.
 */
const holdTurn = async (held: Turn): Promise<void> => {
  const { turn, quick, careful, send } = held;
  let opened = false;
  let early = false;
  let steered = false;
  let notes: Promise<Settled> | null = null;
  const writeNotes = async (): Promise<Settled> => {
    notes ??= settled(write(held, careful));
    return await notes;
  };
  const onText = (written: string) => {
    if (!(opened || early)) {
      const opening = earlyOpening(written);
      opened = opening !== null;
      if (opening !== null) {
        send({ opening });
      }
    }
    if (!early) {
      const line = earlyPlainLine(written);
      early = line !== null;
      if (line !== null && line !== false) {
        send({ line });
      }
      // His line is out: what was said is written down from now on,
      // unless he waits for the rest of it.
      if (early && !waitsForMore(written)) {
        void writeNotes();
      }
    }
    if (early && !steered) {
      const next = earlyNext(written);
      steered = next !== null;
      if (next !== null) {
        send({ next });
      }
    }
  };
  let said: string;
  try {
    said = await speak(held, quick, onText);
  } catch (error) {
    if (!(error instanceof TurnFailedError && error.cause === "declined")) {
      throw error;
    }
    // Declined: asked once more, of the careful model. His line then
    // comes with the whole turn.
    said = await speak(held, careful, unheard);
  }
  const line = plainLine(said);
  const written = line.more === true ? null : await writeNotes();
  if (written?.ok === false) {
    throw written.error;
  }
  const noted = written?.value ?? {};
  const last = turn.lines.findLast(({ from }) => from === "person");
  send({
    turn: checkedTurn(
      { ...line, ...(typeof noted === "object" ? noted : {}) },
      {
        answer: last?.text ?? "",
        known: turn.facts.map(({ id }) => id),
        phase: turn.phase,
      }
    ),
  });
};

const encoder = new TextEncoder();

/** Someone's turn, as the page asks for it: the events, a line of JSON at a time. */
export const interviewTurnResponse = async (
  request: Request,
  env: Env,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      405,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  const raw =
    length > interviewTurnMaxBytes
      ? undefined
      : await boundedText(request.body, interviewTurnMaxBytes);
  const parsed = interviewTurnRequestSchema.safeParse(
    raw === undefined ? undefined : jsonOf(raw)
  );
  if (!parsed.success) {
    return linkRefusal("interview.invalid", requestId);
  }
  const turn = parsed.data;
  const found = await onboardingStore(env).turnContext(
    await sha256Hex(turn.secret),
    await sha256Hex(turn.key)
  );
  if (!found.ok) {
    if (found.code === "interview.link_invalid") {
      log.warn("interview.link_invalid", { requestId });
    }
    return linkRefusal(found.code, requestId);
  }
  const context = found.value;
  const settings = gatewaySettings(env);
  const quick = modelForRole(settings, "quick", { sensitive: true });
  const careful = modelForRole(settings, "careful", { sensitive: true });
  if (quick === undefined || careful === undefined) {
    log.error("interview.no_model", { requestId });
    return Response.json(
      { error: "The interview is not set up yet.", status: 503 },
      { status: 503, headers: linkHeaders }
    );
  }
  const [{ text: system }, organization] = await Promise.all([
    interviewerText(turn.interviewer, context.kind, turn.locale),
    readOrganization(env),
  ]);
  const cut = new AbortController();
  const store = onboardingStore(env);
  const counting: Promise<void>[] = [];
  const count = (took: Took | null) => {
    if (took !== null) {
      counting.push(store.meter(took));
    }
  };
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const deliver = async (event: TurnEvent): Promise<void> => {
    try {
      await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      // The page went away: the turn is given up (below).
      cut.abort();
    }
  };
  const send = (event: TurnEvent) => {
    if (!cut.signal.aborted) {
      void deliver(event);
    }
  };
  // Given up because they talked on, the page closes its end: both models
  // are cut off at once, and what they took is still counted, as the turn
  // runs on until it is (`waitUntil`).
  const given = async (): Promise<void> => {
    try {
      await writer.closed;
    } catch {
      cut.abort();
    }
  };
  void given();
  const held = (async () => {
    try {
      await holdTurn({
        env,
        turn,
        context,
        system,
        brief: briefOf(turn, context, organization.name),
        quick,
        careful,
        signal: cut.signal,
        send,
        count,
      });
    } catch (error) {
      const failed =
        error instanceof TurnFailedError
          ? error
          : refusalOf(modelErrors.codeOf(error));
      if (!(error instanceof TurnFailedError || cut.signal.aborted)) {
        log.error("interview.turn_failed", { requestId });
      }
      send({ error: failed.message, status: failed.status });
    }
    await Promise.allSettled(counting);
    await writer.close().catch(() => null);
  })();
  ctx.waitUntil(held);
  return new Response(readable, {
    headers: {
      ...linkHeaders,
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
};
