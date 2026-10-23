import { sha256Hex } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import {
  hearErrors,
  hearFieldsSchema,
  hearMaxBytes,
  hearSecondsMax,
} from "@grasp-os/shared/interview-hear";
import type { HearAnswer } from "@grasp-os/shared/interview-hear";
import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { errorResponse } from "../errors.ts";
import { voiceGatewayRoute } from "../models.ts";
import { boundedBytes } from "../request-body.ts";
import { linkHeaders, linkRefusal } from "./links.ts";
import { onboardingStore } from "./store.ts";
import { heardBudgets } from "./transcription.ts";

// `POST /api/interview/hear` (`@grasp-os/shared/interview-hear`): a
// stretch of what someone said on their interview link, written down from
// its recording, when the live line (`GET /api/transcription`,
// transcription.ts) couldn't be used or its words didn't come in time.
// Ported from the prototype (grasplabs/prototype, packages/grasp:
// worker/interview.ts, `hear`).
//
// Written down by ElevenLabs's Scribe through the deployment's AI Gateway,
// on the path live transcription and speech take (`voiceGatewayRoute`),
// with the key the gateway stores: core sends none, and asks ElevenLabs
// to keep nothing (`enable_logging=false`). The words to listen out for
// are the store's (`listeningTerms`), never the page's.
//
// What it must not do, and what stops it:
//
// - Write down anything for anyone: only someone's own link, on the device
//   it is open on, while it may be saved (the store's
//   `transcriptionOnLink`, as the live line). Nothing reaches the upstream
//   before that.
// - Keep the audio: the recording is read, sent on and dropped. Nothing
//   heard is logged, counted or audited; only its seconds are counted.
// - Run up the bill: a recording is at most `hearMaxBytes` and
//   `hearSecondsMax` long; what is written down counts against the same
//   minutes a day as the live line (`heardBudgets`); the router limits the
//   endpoint per address, as every link endpoint.

/** The model a recording is written down by: ElevenLabs's Scribe v2, for whole recordings. */
const scribeModel = "scribe_v2";

/** How long the upstream may take to write a recording down. */
const hearTimeoutMs = 20_000;

/** Scribe's answer, as far as it is read: the words, as one text. */
const writtenSchema = z.object({ text: z.string() });

/** An answer of this endpoint: never a referrer, never kept by a browser. */
const answered = (answer: HearAnswer): Response =>
  Response.json(answer, { headers: linkHeaders });

const refused = (
  status: number,
  error: CodedError,
  requestId: string
): Response => {
  const response = errorResponse(status, error, requestId);
  for (const [name, value] of Object.entries(linkHeaders)) {
    response.headers.set(name, value);
  }
  return response;
};

/** The page's form, read no further than it may be: its fields, and the recording. */
interface Asked extends z.output<typeof hearFieldsSchema> {
  audio: File;
}

const formOf = async (request: Request): Promise<Asked | null> => {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > hearMaxBytes) {
    return null;
  }
  const bytes = await boundedBytes(request.body, hearMaxBytes);
  if (bytes === undefined) {
    return null;
  }
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return null;
  }
  const fields = hearFieldsSchema.safeParse({
    secret: form.get("secret"),
    key: form.get("key"),
    locale: form.get("locale"),
    seconds: form.get("seconds"),
  });
  const audio = form.get("audio");
  if (!fields.success || !(audio instanceof File) || audio.size === 0) {
    return null;
  }
  return { ...fields.data, audio };
};

/** What the upstream wrote down, or why not: `undefined` when it failed. */
const writtenDown = async (
  env: Env,
  asked: Asked,
  keyterms: readonly string[],
  requestId: string
): Promise<string | undefined> => {
  const route = voiceGatewayRoute(env);
  if (route === undefined) {
    return undefined;
  }
  const sent = new FormData();
  sent.set("model_id", scribeModel);
  sent.set("language_code", asked.locale);
  sent.set("tag_audio_events", "false");
  for (const term of keyterms) {
    sent.append("keyterms", term);
  }
  sent.set("file", asked.audio, "stretch");
  let answer: Response;
  try {
    answer = await route.transport(
      `${route.base}/v1/speech-to-text?enable_logging=false`,
      {
        method: "POST",
        headers: route.headers,
        body: sent,
        signal: AbortSignal.timeout(hearTimeoutMs),
      }
    );
  } catch {
    log.warn("hear.failed", { requestId });
    return undefined;
  }
  let body: unknown = undefined;
  try {
    body = answer.ok ? await answer.json() : undefined;
  } catch {
    // Read below as a failure.
  }
  const written = writtenSchema.safeParse(body);
  if (!written.success) {
    // Never what was said: only that it failed, and how.
    log.warn("hear.failed", { requestId, status: answer.status });
    if (!answer.bodyUsed) {
      await answer.body?.cancel();
    }
    return undefined;
  }
  return written.data.text.trim();
};

/** `POST /api/interview/hear`: a recording on someone's link, written down. */
export const hearResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      405,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const asked = await formOf(request);
  if (asked === null) {
    return refused(400, hearErrors.create("hear.invalid"), requestId);
  }
  const store = onboardingStore(env);
  const found = await store.transcriptionOnLink(
    await sha256Hex(asked.secret),
    await sha256Hex(asked.key)
  );
  if (!found.ok) {
    if (found.code === "interview.link_invalid") {
      // Never the secret: only that one opened nothing.
      log.warn("interview.link_invalid", { requestId });
    }
    return linkRefusal(found.code, requestId);
  }
  const { who, heard, person } = found.value;
  if (heard >= heardBudgets.link) {
    return refused(429, hearErrors.create("hear.limited"), requestId);
  }
  if (voiceGatewayRoute(env) === undefined) {
    return refused(503, hearErrors.create("hear.unavailable"), requestId);
  }
  const keyterms = await store.listeningTerms(person);
  const text = await writtenDown(env, asked, keyterms, requestId);
  if (text === undefined) {
    return refused(502, hearErrors.create("hear.failed"), requestId);
  }
  try {
    // The stretch as the page measured it: never more than it may be.
    await store.countHeard(
      who,
      "interviews",
      Math.min(hearSecondsMax, asked.seconds)
    );
  } catch {
    log.error("hear.count_failed", { requestId });
  }
  return answered({ heard: text });
};
