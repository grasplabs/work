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
import { modelErrors } from "@grasp-os/shared/models";
import { z } from "zod";

import { errorResponse } from "../errors.ts";
import { models } from "../models.ts";
import type { Listening } from "../models.ts";
import { boundedBytes } from "../request-body.ts";
import { linkHeaders, linkRefusal } from "./links.ts";
import { onboardingStore } from "./store.ts";
import { heardBudgets, transcriptionModel } from "./transcription.ts";

// `POST /api/interview/hear` (`@grasp-os/shared/interview-hear`): a
// stretch of what someone said on their interview link, written down from
// its recording, when the live line (`GET /api/transcription`,
// transcription.ts) couldn't be used or its words didn't come in time.
// Ported from the prototype (grasplabs/prototype, packages/grasp:
// worker/interview.ts, `hear`).
//
// Written down by Grasp's transcription model (src/platform-ai.ts), the
// one live transcription takes, through connect with Grasp's own key: core sends
// none. Only once the model gateway admitted it (models.ts,
// `models(env).listen`): the rules judge it, and the deployment's budgets
// hold its seconds, before anything is sent; the way to the upstream is
// the one its admission hands over. The words to listen out for are the
// store's (`listeningTerms`), never the page's.
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
//   `hearSecondsMax` long; the model gateway admits it against the
//   deployment's budgets for its seconds, refused as any model call when
//   they have no room (`hear.over_budget`), and charges and audits what
//   was heard once it is written down, never anything heard. The minutes a
//   day the live line has (`heardBudgets`) stay a second bound, below the
//   budgets; the router limits the endpoint per address, as every link
//   endpoint.

/** What the gateway is told every recording is for. */
const purpose = "onboarding.hear";

/** How long the upstream may take to write a recording down. */
const hearTimeoutMs = 20_000;

type HearCode = Parameters<typeof hearErrors.create>[0];

/** The gateway's refusals, as the page is told them; any other is a failure. */
const gatewayRefusals: Partial<Record<string, readonly [number, HearCode]>> = {
  "model.over_budget": [429, "hear.over_budget"],
  "model.budget_busy": [503, "hear.busy"],
  "model.queued": [503, "hear.busy"],
  "model.unconfigured": [503, "hear.unavailable"],
  "model.not_allowed": [503, "hear.unavailable"],
  "model.eu_only": [503, "hear.unavailable"],
  "model.sensitive_data": [503, "hear.unavailable"],
  "model.unpriced": [503, "hear.unavailable"],
};

/**
 * The file name a recording goes to the provider under, by its media type:
 * OpenAI tells the audio's format by the name's extension alone, and
 * refuses a file without one it takes (flac, m4a, mp3, mp4, mpeg, mpga,
 * oga, ogg, wav, webm). What browsers record: WebM or Ogg with Opus
 * (Chrome, Firefox), MP4/M4A with AAC (Safari), WAV.
 */
const recordingExtensions: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "video/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

/** The name `audio` is sent under; `undefined` for a type it can't be sent as. */
export const recordingName = (audio: Blob): string | undefined => {
  const [type = ""] = audio.type.toLowerCase().split(";");
  const extension = recordingExtensions[type.trim()];
  return extension === undefined ? undefined : `stretch.${extension}`;
};

/** The provider's answer, as far as it is read: the words, as one text. */
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
  /** The name it goes to the provider under (`recordingName`). */
  name: string;
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
  // A recording of a type the provider can't take is refused here, before
  // anything is admitted or sent.
  const name = recordingName(audio);
  return name === undefined ? null : { ...fields.data, audio, name };
};

/** What the upstream wrote down, or why not: `undefined` when it failed. */
const writtenDown = async (
  listening: Listening,
  asked: Asked,
  keyterms: readonly string[],
  requestId: string
): Promise<string | undefined> => {
  const sent = new FormData();
  sent.set("model", listening.modelId);
  sent.set("language", asked.locale);
  sent.set("response_format", "json");
  if (keyterms.length > 0) {
    sent.set("prompt", `Names and terms: ${keyterms.join(", ")}.`);
  }
  sent.set("file", asked.audio, asked.name);
  let answer: Response;
  try {
    answer = await listening.send(
      "/v1/audio/transcriptions",
      { headers: {}, body: sent },
      AbortSignal.timeout(hearTimeoutMs)
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

/**
 * The model gateway's admission for `seconds` of a recording, or the
 * page's refusal when it wasn't admitted (audited by the gateway).
 */
const admitted = async (
  env: Env,
  seconds: number,
  requestId: string
): Promise<Listening | Response> => {
  try {
    return await models(env).listen({
      model: transcriptionModel,
      seconds,
      // Admitted within half of it at most, written down in the rest.
      openMs: 2 * hearTimeoutMs,
      purpose,
      // A recording on a link is the system's, as a line said on one is.
      trigger: { type: "system" },
      work: { onboarding: true },
      requestId,
    });
  } catch (error) {
    const modelCode = modelErrors.codeOf(error);
    const [status, code] = gatewayRefusals[modelCode ?? ""] ?? [
      502,
      "hear.failed",
    ];
    log.warn("hear.unadmitted", { requestId, code: modelCode ?? code });
    return refused(status, hearErrors.create(code), requestId);
  }
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
  // The stretch as the page measured it: never more than it may be.
  const seconds = Math.min(hearSecondsMax, asked.seconds);
  const keyterms = await store.listeningTerms(person);
  const listening = await admitted(
    env,
    Math.max(1, Math.ceil(seconds)),
    requestId
  );
  if (listening instanceof Response) {
    return listening;
  }
  const text = await writtenDown(listening, asked, keyterms, requestId);
  // Sent upstream either way, so charged either way.
  await listening.heard(seconds, text === undefined ? "failed" : "answered");
  if (text === undefined) {
    return refused(502, hearErrors.create("hear.failed"), requestId);
  }
  try {
    await store.countHeard(who, "interviews", seconds);
  } catch {
    log.error("hear.count_failed", { requestId });
  }
  return answered({ heard: text });
};
