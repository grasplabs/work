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
  participationNotice,
} from "@grasp-os/shared/interview-links";
import type {
  ApprovedFact,
  InterviewRequest,
} from "@grasp-os/shared/interview-links";
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
// (`/api/interview`, `/turn`, `/story`), with the link's secret in each
// body and the session of the company's sign-in in its cookie, which core
// reads on these endpoints alone (GRA-1790): the interview opens only for
// the account it belongs to. Nothing it is answered is taken on trust:
// each answer is checked against the shape core promises.

/** What a call that didn't work tells: its HTTP status (0 when nothing came back), core's code, and words for people. */
export interface Refused {
  refused: true;
  status: number;
  code: string | null;
  message: string;
}

export const isRefused = (value: unknown): value is Refused =>
  typeof value === "object" && value !== null && "refused" in value;

const sessionSchema = z.object({
  state: z.literal("open"),
  name: z.string(),
  team: z.string(),
  lead: z.string().nullable(),
  kind: interviewKindSchema,
  closes: z.string(),
  closed: z.boolean(),
  progress: interviewProgressSchema.nullable(),
  version: z.int().min(0),
  withdrawn: z.boolean(),
});
export type OpenSession = z.output<typeof sessionSchema>;

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

const participationSchema = z.object({ notice: z.int(), at: z.string() });

const approvalSchema = z.union([
  z.object({
    approved: z.literal(true),
    receipt: z.string(),
    at: z.string(),
  }),
  z.object({
    approved: z.literal(false),
    version: z.int().min(0),
    progress: interviewProgressSchema.nullable(),
  }),
]);
export type ApprovalAnswer = z.output<typeof approvalSchema>;

const withdrawnSchema = z.object({
  withdrawn: z.literal(true),
  at: z.string(),
});

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
      keepalive,
      signal: AbortSignal.timeout(callTimeoutMs),
    });
  } catch {
    return unreachable();
  }
  if (!response.ok && response.status !== 409) {
    return await refusalOf(response);
  }
  if (response.status === 409) {
    // A 409 is the copy kept, or a refusal with its code (a notice that
    // changed): the refusal is told as it is, never tried again.
    const refusal = await refusalOf(response.clone());
    if (refusal.code !== null) {
      return refusal;
    }
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

/** Opens the link for whoever is signed in: their interview, or why not. */
export const openSession = async (
  secret: string
): Promise<OpenSession | Refused> =>
  await posted(
    interviewApiPath,
    { action: "session", secret } satisfies InterviewRequest,
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
  secret: string
): Promise<{ deleted: true } | Refused> =>
  await posted(
    interviewApiPath,
    { action: "delete", secret } satisfies InterviewRequest,
    deletedSchema
  );

/** They read what this is for and agree to take part, to the notice as this page shows it. */
export const participate = async (
  secret: string
): Promise<z.output<typeof participationSchema> | Refused> =>
  await posted(
    interviewApiPath,
    {
      action: "participate",
      secret,
      notice: participationNotice.version,
    } satisfies InterviewRequest,
    participationSchema
  );

/** They approve the facts read back to them, each at the revision they saw. */
export const approveFacts = async (
  secret: string,
  facts: ApprovedFact[]
): Promise<ApprovalAnswer | Refused> =>
  await posted(
    interviewApiPath,
    { action: "approve", secret, facts } satisfies InterviewRequest,
    approvalSchema
  );

/** They withdraw: nothing of their interview is used from now on. */
export const withdrawInterview = async (
  secret: string
): Promise<z.output<typeof withdrawnSchema> | Refused> =>
  await posted(
    interviewApiPath,
    { action: "withdraw", secret } satisfies InterviewRequest,
    withdrawnSchema
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
      signal: AbortSignal.timeout(storyTimeoutMs),
    });
    return response.ok ? storyOf(await response.json(), request.lines) : null;
  } catch {
    return null;
  }
};

/** Where this tab keeps a link's secret while it is away signing in. */
const signingInSecret = "grasp.interview.signing-in";

/**
 * The secret in the page's link: what follows its `#`; or, back from
 * signing in, the one this tab kept while it was away (`keepWhileSigningIn`),
 * put back in the address and forgotten here.
 */
export const linkSecret = (): string => {
  const inLink = window.location.hash.slice(1);
  let kept: string | null = null;
  try {
    kept = sessionStorage.getItem(signingInSecret);
    sessionStorage.removeItem(signingInSecret);
  } catch {
    // Storage refused: the link's own address is all there is.
  }
  if (inLink !== "" || kept === null) {
    return inLink;
  }
  window.history.replaceState(null, "", `${window.location.pathname}#${kept}`);
  return kept;
};

/**
 * Keeps the link's secret in this tab alone while it is away signing in:
 * the company's sign-in sends it back without what follows the `#`. Never
 * in the address the sign-in keeps, which core stores until it is back.
 */
export const keepWhileSigningIn = (secret: string): void => {
  try {
    sessionStorage.setItem(signingInSecret, secret);
  } catch {
    // Storage refused: they open their link again from their email.
  }
};

/** Where this browser keeps what belongs to a link: under a hash of its secret, never the secret itself. */
const linkName = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `grasp.interview.${hex}`;
};

/** Where what they typed and did not send is kept, per link. */
export const draftName = async (secret: string): Promise<string> =>
  `${await linkName(secret)}.draft`;

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
