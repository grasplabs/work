import {
  errorPayloadSchema,
  requestIdOf,
  withReference,
} from "@grasp-os/shared/errors";
import { requestIdHeader } from "@grasp-os/shared/http";
import {
  hearAnswerSchema,
  hearSecondsMax,
  interviewHearPath,
} from "@grasp-os/shared/interview-hear";
import type { HearFields } from "@grasp-os/shared/interview-hear";
import {
  interviewApiPath,
  interviewProgressSchema,
} from "@grasp-os/shared/interview-links";
import type { InterviewRequest } from "@grasp-os/shared/interview-links";
import { interviewStoryPath, storyOf } from "@grasp-os/shared/interview-story";
import type {
  InterviewStoryRequest,
  StoryLine,
  StorySentence,
} from "@grasp-os/shared/interview-story";
import { interviewTurnPath, turnEvents } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import { interviewKindSchema } from "@grasp-os/shared/onboarding";
import { t } from "@lingui/core/macro";
import { z } from "zod";

// The interview's page talks to core over its link's endpoints only
// (`/api/interview`, `/turn`, `/story`), with the link's secret and the
// device's key in each body: it has no session, never opens `/rpc`, and
// sends no cookie. Nothing it is answered is taken on trust: each answer is
// checked against the shape core promises.

/** What a call that didn't work tells: its HTTP status (0 when nothing came back), core's code, and words for people. */
export interface Refused {
  refused: true;
  status: number;
  code: string | null;
  message: string;
}

export const isRefused = (value: unknown): value is Refused =>
  typeof value === "object" && value !== null && "refused" in value;

const sessionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("open"),
    key: z.string().optional(),
    name: z.string(),
    team: z.string(),
    lead: z.string().nullable(),
    kind: interviewKindSchema,
    closes: z.string(),
    closed: z.boolean(),
    progress: interviewProgressSchema.nullable(),
    version: z.int().min(0),
  }),
  z.object({ state: z.literal("elsewhere") }),
]);
export type SessionAnswer = z.output<typeof sessionSchema>;
export type OpenSession = Extract<SessionAnswer, { state: "open" }>;

const savedSchema = z.union([
  z.object({ saved: z.literal(true), version: z.int().min(0) }),
  z.object({
    saved: z.literal(false),
    version: z.int().min(0),
    progress: interviewProgressSchema.nullable(),
  }),
]);
export type SaveAnswer = z.output<typeof savedSchema>;

const deletedSchema = z.object({ deleted: z.literal(true) });

/** How long a call to keep or open may take. */
const callTimeoutMs = 30_000;

/** Nothing came back: most likely their connection. */
const unreachable = (): Refused => ({
  refused: true,
  status: 0,
  code: null,
  message: t`Grasp can't be reached right now. Try again in a moment.`,
});

/** A refusal as core sent it, with its reference. */
const refusalOf = async (response: Response): Promise<Refused> => {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // No body to read: the status says enough.
  }
  const parsed = errorPayloadSchema.safeParse(payload);
  return {
    refused: true,
    status: response.status,
    code: parsed.success ? parsed.data.code : null,
    message: withReference(
      parsed.success
        ? parsed.data.message
        : t`That didn't work. Try again in a moment.`,
      requestIdOf(payload) ?? response.headers.get(requestIdHeader) ?? undefined
    ),
  };
};

/** One POST with a JSON body, its answer read with `schema`; a 409 is an answer too. */
const posted = async <T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  { keepalive = false }: { keepalive?: boolean } = {}
): Promise<T | Refused> => {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // No cookie of anyone's goes with it: the link is all it has.
      credentials: "omit",
      keepalive,
      signal: AbortSignal.timeout(callTimeoutMs),
    });
  } catch {
    return unreachable();
  }
  if (!response.ok && response.status !== 409) {
    return await refusalOf(response);
  }
  try {
    const parsed = schema.safeParse(await response.json());
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Read below as a failure on our side.
  }
  return {
    refused: true,
    status: 502,
    code: null,
    message: t`That didn't work. Try again in a moment.`,
  };
};

/** Opens the link on this device: the interview, or that it is open elsewhere. */
export const openSession = async (
  secret: string,
  key: string | undefined
): Promise<SessionAnswer | Refused> =>
  await posted(
    interviewApiPath,
    {
      action: "session",
      secret,
      ...(key === undefined ? {} : { key }),
    } satisfies InterviewRequest,
    sessionSchema
  );

/** Keeps where the interview stands, as of `version`. */
export const saveProgress = async (
  request: Extract<InterviewRequest, { action: "save" }>,
  { keepalive = false }: { keepalive?: boolean } = {}
): Promise<SaveAnswer | Refused> =>
  await posted(interviewApiPath, request, savedSchema, { keepalive });

/** Deletes everything said on the link. */
export const deleteInterview = async (
  secret: string,
  key: string
): Promise<{ deleted: true } | Refused> =>
  await posted(
    interviewApiPath,
    { action: "delete", secret, key } satisfies InterviewRequest,
    deletedSchema
  );

/** A turn that could not be had: its status, 0 when nothing came back. */
export interface TurnFailed {
  failed: true;
  status: number;
}

export const turnFailed = (value: unknown): value is TurnFailed =>
  typeof value === "object" && value !== null && "failed" in value;

/** What comes in of a turn before the whole of it: his line's start, his line, where the interview goes. */
export type EarlyEvent = Exclude<
  TurnEvent,
  { turn: StephenTurn } | { error: string; status: number }
>;

/**
 * One turn, as core answers it, a line of JSON at a time: `onEvent` gets
 * each event as it comes in, and `alive` is called whenever anything does.
 * What comes back is the whole turn, or that it failed.
 */
export const askTurn = async (
  request: InterviewTurnRequest,
  signal: AbortSignal,
  onEvent: (event: EarlyEvent) => void,
  alive: () => void
): Promise<StephenTurn | TurnFailed> => {
  const response = await fetch(interviewTurnPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    credentials: "omit",
    signal,
  });
  if (!response.ok || response.body === null) {
    return { failed: true, status: response.status };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let turn: StephenTurn | TurnFailed = { failed: true, status: 0 };
  let arrived = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read a piece at a time
    const { done, value } = await reader.read();
    alive();
    // The last line counts too, whether or not it ends in a new line.
    const text = `${arrived}${decoder.decode(value, { stream: !done })}${done ? "\n" : ""}`;
    const { events, rest } = turnEvents(text);
    arrived = rest;
    for (const event of events) {
      if ("turn" in event) {
        ({ turn } = event);
      } else if ("error" in event) {
        turn = { failed: true, status: event.status };
      } else {
        onEvent(event);
      }
    }
    if (done) {
      return turn;
    }
  }
};

/** How long a story of a part is waited for at all. */
const storyTimeoutMs = 8000;

/**
 * A part of the read-back as Stephen tells it: its lines as a short story,
 * held to the same rules here as in core; none when it can't be had, and
 * then he reads the lines as they stand.
 */
export const askStory = async (
  request: Omit<InterviewStoryRequest, "lines"> & { lines: StoryLine[] }
): Promise<StorySentence[] | null> => {
  try {
    const response = await fetch(interviewStoryPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      credentials: "omit",
      signal: AbortSignal.timeout(storyTimeoutMs),
    });
    return response.ok ? storyOf(await response.json(), request.lines) : null;
  } catch {
    return null;
  }
};

/** The secret in the page's link: what follows its `#`. */
export const linkSecret = (): string => window.location.hash.slice(1);

/** Where this browser keeps the device's key for a link: under a hash of its secret, never the secret itself. */
const keyName = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `grasp.interview.${hex}`;
};

/** The key this device was given for the link, if it was. */
export const keptKey = async (secret: string): Promise<string | undefined> => {
  try {
    return localStorage.getItem(await keyName(secret)) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Keeps the device's key, given once: without it, the link opens on no
 * device again until Grasp's staff give it a new start.
 */
export const keepKey = async (secret: string, key: string): Promise<void> => {
  try {
    localStorage.setItem(await keyName(secret), key);
  } catch {
    // A private window can refuse storage: the interview then lasts as long as the page.
  }
};

/** Where what they typed and did not send is kept, per link. */
export const draftName = async (secret: string): Promise<string> =>
  `${await keyName(secret)}.draft`;

/** How long a recording may take to be written down. */
const hearTimeoutMs = 20_000;

/**
 * A stretch they said, written down from its recording, when it couldn't
 * be as they said it: what was heard, or why not. The recording is sent
 * once and kept nowhere.
 */
export const hearRecording = async ({
  audio,
  ...fields
}: Omit<HearFields, "seconds"> & {
  seconds: number;
  audio: Blob;
}): Promise<{ heard: string } | { reason: "failed" | "limited" }> => {
  const form = new FormData();
  form.set("secret", fields.secret);
  form.set("key", fields.key);
  form.set("locale", fields.locale);
  form.set(
    "seconds",
    String(Math.min(hearSecondsMax, Math.max(0, fields.seconds)))
  );
  form.set("audio", audio, "stretch");
  try {
    const response = await fetch(interviewHearPath, {
      method: "POST",
      body: form,
      credentials: "omit",
      signal: AbortSignal.timeout(hearTimeoutMs),
    });
    if (!response.ok) {
      return { reason: response.status === 429 ? "limited" : "failed" };
    }
    const parsed = hearAnswerSchema.safeParse(await response.json());
    return parsed.success
      ? { heard: parsed.data.heard.trim() }
      : { reason: "failed" };
  } catch {
    return { reason: "failed" };
  }
};
