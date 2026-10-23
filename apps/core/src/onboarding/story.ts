import { sha256Hex } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import {
  interviewStoryMaxBytes,
  interviewStoryRequestSchema,
  storyOf,
  storySchema,
} from "@grasp-os/shared/interview-story";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";

import { errorResponse } from "../errors.ts";
import { gatewaySettings, modelForRole, models } from "../models.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { tellingText } from "./interviewer-text.ts";
import { linkHeaders, linkRefusal } from "./links.ts";
import { onboardingStore } from "./store.ts";

// The read-back as Stephen tells it, `POST /api/interview/story`, on
// someone's own link: the lines of one part of what he wrote down, told
// back as a short story, with the lines that belong together in one
// sentence. The lines stay what the person reads, changes and agrees to;
// this is only how he says them, so nothing is written down or changed
// here. Ported from the prototype (grasplabs/prototype, packages/grasp:
// worker/story.ts).
//
// Like a turn (interview.ts): the link's secret and the device's key are
// checked by the store, which also limits calls per link; the gateway call
// is made by the system for `onboarding.interview`, never in anyone's
// name, and counts as carrying sensitive data; and what it took is counted
// in the onboarding's AI use.

/** The most a story takes to write: a part is a few short sentences. */
const storyTokens = 1000;

/** What the page does when there is no story: it reads the lines as they stand. */
const asTheyStand = (status: number): Response =>
  Response.json(
    { error: "Stephen reads the lines as they are.", status },
    { status, headers: linkHeaders }
  );

/** The sentences Stephen says to tell one part back, as `{ sentences }`. */
export const interviewStoryResponse = async (
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
    length > interviewStoryMaxBytes
      ? undefined
      : await boundedText(request.body, interviewStoryMaxBytes);
  const parsed = interviewStoryRequestSchema.safeParse(
    raw === undefined ? undefined : jsonOf(raw)
  );
  if (!parsed.success) {
    return linkRefusal("interview.invalid", requestId);
  }
  const asked = parsed.data;
  const store = onboardingStore(env);
  const found = await store.turnContext(
    await sha256Hex(asked.secret),
    await sha256Hex(asked.key)
  );
  if (!found.ok) {
    if (found.code === "interview.link_invalid") {
      log.warn("interview.link_invalid", { requestId });
    }
    return linkRefusal(found.code, requestId);
  }
  // The model that says his lines tells it: someone is waiting for it.
  const model = modelForRole(gatewaySettings(env), "quick", {
    sensitive: true,
  });
  if (model === undefined) {
    log.error("interview.no_model", { requestId });
    return asTheyStand(503);
  }
  const { text: system } = await tellingText(asked.interviewer, asked.locale);
  try {
    const { output, usage } = await models(env).call({
      model,
      purpose: "onboarding.interview",
      trigger: { type: "system" },
      work: { onboarding: true },
      effort: "low",
      system,
      input: `The lines of this part:\n${asked.lines.map(({ id, text }) => `- [${id}] ${text}`).join("\n")}\n\nTell them back.`,
      schema: storySchema,
      maxTokens: storyTokens,
      signal: request.signal,
    });
    ctx.waitUntil(
      store.meter({
        purpose: "interviews",
        model,
        tokensIn: usage.inputTokens,
        tokensCached: usage.cacheRead,
        tokensOut: usage.outputTokens,
      })
    );
    const sentences = storyOf(output, asked.lines);
    if (sentences === null) {
      return asTheyStand(502);
    }
    return Response.json({ sentences }, { headers: linkHeaders });
  } catch (error) {
    const code = modelErrors.codeOf(error);
    if (code === undefined && !request.signal.aborted) {
      log.error("interview.story_failed", { requestId });
    }
    return asTheyStand(
      code === "model.budget_busy" || code === "model.rate_limited" ? 429 : 502
    );
  }
};
