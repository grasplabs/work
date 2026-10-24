import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { interviewSecretSchema } from "./interview-links.ts";
import { interviewLocaleSchema } from "./onboarding.ts";

// `POST /api/interview/hear` (core's onboarding/hear.ts): a stretch of what
// someone said on their interview link, written down from its recording.
// The page's way when the live line (`GET /api/transcription`) can't be
// used, or its words don't come in time. Authorised to the link as the
// rest of it is: the link's secret and the device's key go with it. The
// recording is written down and dropped: never kept, nor logged.

export const interviewHearPath = "/api/interview/hear";

/** The longest stretch the page records, in seconds, and so the most one recording may be. */
export const hearSecondsMax = 30;

/**
 * The most bytes a request may hold: half a minute of the page's
 * recording (Opus in WebM or MP4, some 4 KB a second) many times over,
 * and the fields beside it.
 */
export const hearMaxBytes = 1024 * 1024;

/** The fields beside the recording (`audio`), as the form sends them. */
export const hearFieldsSchema = z.strictObject({
  secret: interviewSecretSchema,
  key: interviewSecretSchema,
  locale: interviewLocaleSchema,
  /** How long there was a voice in the stretch, as the page measured it. */
  seconds: z.coerce.number().min(0).max(hearSecondsMax),
});
export type HearFields = z.input<typeof hearFieldsSchema>;

/** What was said in the recording; empty when nothing was. */
export const hearAnswerSchema = z.object({ heard: z.string() });
export type HearAnswer = z.output<typeof hearAnswerSchema>;

/** Why a recording wasn't written down. */
export const hearErrors = defineErrorFamily({
  "hear.invalid": "That isn't a recording that can be written down.",
  "hear.limited":
    "Grasp has listened a lot today on this link. Type your answer, and it listens again tomorrow.",
  "hear.over_budget":
    "The AI budget for listening is used up. Type your answer for now.",
  "hear.busy":
    "Listening is busy right now. Type your answer, or try again in a moment.",
  "hear.unavailable": "Listening isn't set up for this deployment yet.",
  "hear.failed": "That couldn't be written down. Say it once more, or type it.",
});
