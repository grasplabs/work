/**
 * The local core the lab runs against (`vp run dev`), as the lab reaches
 * it: Grasp's staff member of the local stack, signed in through the fake
 * IdP as the seed signs people in (scripts/seed/local.ts); the lab's own
 * model calls, through core's model gateway (`/api/lab`, core's
 * onboarding/lab.ts); and someone's interview, on their own link, exactly
 * as the interview page talks to core. Every turn is a real turn of core.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { ModelRole } from "@grasp-os/shared/deployment-config";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import {
  interviewApiPath,
  interviewProgressSchema,
} from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { interviewTurnPath, turnEvents } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
} from "@grasp-os/shared/interview-turn";
import {
  labAnswerSchema,
  labJsonSchema,
  labLinksSchema,
  labPath,
  labViaSchema,
} from "@grasp-os/shared/lab";
import type { LabRequest, LabVia } from "@grasp-os/shared/lab";
import type { ModelEffort } from "@grasp-os/shared/models";
import { interviewKindSchema } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { localStaff } from "../../apps/core/test/sign-in-config.ts";
import { cookieHeader, origin, sessionOf } from "../seed/local.ts";
import type { Session } from "../seed/local.ts";

/** Why the local core refused or failed something the lab asked. */
export class CoreCallError extends Error {
  override name = "CoreCallError";
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** How long the lab waits before it asks again what was too busy to answer. */
const busyWaitMs = 30_000;
/** How often it asks again before it gives up. */
const busyTries = 4;

/** Whether a refusal is worth asking again, after a while. */
const isBusy = (error: unknown): boolean =>
  error instanceof CoreCallError && error.status === 429;

/** Runs `call` again while core is busy, a few times, then gives up. */
export const whileBusy = async <T>(call: () => Promise<T>): Promise<T> => {
  for (let tries = 1; ; tries += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time
      return await call();
    } catch (error) {
      if (!isBusy(error) || tries >= busyTries) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- waits before the next try
      await sleep(busyWaitMs);
    }
  }
};

/** A refusal's message and code, from a response that isn't ok. */
const refusalOf = async (
  response: Response,
  what: string
): Promise<CoreCallError> => {
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status says it.
  }
  const payload = errorPayloadSchema.safeParse(body);
  return payload.success
    ? new CoreCallError(
        `${what}: ${payload.data.message} (${payload.data.code})`,
        response.status,
        payload.data.code
      )
    : new CoreCallError(`${what} failed (${response.status})`, response.status);
};

/** What the lab has spent on models so far, as the gateway priced it. */
const spent = { dollars: 0, calls: 0 };

/** What the lab spent, for every command to print. */
export const spentLine = (): string =>
  `${spent.calls} calls of the lab's own, about $${spent.dollars.toFixed(2)} (Stephen's own turns are counted by the onboarding)`;

/** The local core, as Grasp's staff member of the stack. */
export interface Core {
  session: Session;
  /** How core reaches its models: what every result is labelled with. */
  via: LabVia;
}

/** Asks `/api/lab`, as staff. */
const labCall = async (
  session: Pick<Session, "cookie">,
  body: LabRequest
): Promise<unknown> => {
  const response = await fetch(new URL(labPath, origin), {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: cookieHeader(session.cookie),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await refusalOf(response, "The lab's call to core");
  }
  return await response.json();
};

/**
 * Signs in as the stack's staff member and asks how core reaches its
 * models. Refuses to go on unless core runs on this machine with the fake
 * IdP (scripts/seed/local.ts), so nothing but a local stack is ever used.
 */
export const openCore = async (): Promise<Core> => {
  const session = await sessionOf(localStaff, { providerId: "grasp-staff" });
  const via = labViaSchema.parse(await labCall(session, { action: "via" }));
  return { session, via };
};

/** Everyone's interview link, by roster ID. */
export const linksOf = async (core: Core): Promise<Map<string, string>> => {
  const { links } = labLinksSchema.parse(
    await labCall(core.session, { action: "links" })
  );
  return new Map(links.map(({ person, link }) => [person, link]));
};

/** One model call of the lab's own, through core's gateway. */
export interface Ask<T> {
  /** `quick` for someone who answers, `careful` for the judge. */
  role: ModelRole;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort?: ModelEffort;
}

/** Asks a model through core's gateway, and holds its answer to `schema`. */
export const ask = async <T>(core: Core, call: Ask<T>): Promise<T> =>
  await whileBusy(async () => {
    const answer = labAnswerSchema.parse(
      await labCall(core.session, {
        action: "ask",
        role: call.role,
        system: call.system,
        input: call.input,
        schema: labJsonSchema.parse(z.toJSONSchema(call.schema)),
        maxTokens: call.maxTokens,
        ...(call.effort === undefined ? {} : { effort: call.effort }),
      })
    );
    spent.dollars += answer.cost;
    spent.calls += 1;
    return call.schema.parse(answer.output);
  });

/** A link's secret: what comes after the `#`. */
export const secretOf = (link: string): string => link.split("#")[1] ?? "";

/** Posts to the interview page's endpoint, as the page does. */
const interviewCall = async (body: unknown): Promise<unknown> => {
  const response = await fetch(new URL(interviewApiPath, origin), {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await refusalOf(response, "The interview");
  }
  return await response.json();
};

const savedSchema = z.object({ saved: z.boolean(), version: z.int() });

/** What a link opens, read as far as the lab needs it. */
const sessionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("elsewhere") }),
  z.object({
    state: z.literal("open"),
    key: z.string().optional(),
    name: z.string(),
    kind: interviewKindSchema,
    progress: interviewProgressSchema.nullable(),
    version: z.int(),
  }),
]);
export type LinkSession = z.output<typeof sessionSchema>;

/** Someone's interview, on their own link, as their page holds it. */
export interface Link {
  /** Opens the link on this device: its key the first time, and what was said. */
  open: (key?: string) => Promise<LinkSession>;
  /** Keeps where the interview is; the version it was kept as. */
  save: (
    key: string,
    version: number,
    progress: InterviewProgress
  ) => Promise<number>;
  /** One turn of Stephen's. */
  turn: (
    request: Omit<InterviewTurnRequest, "secret" | "key">,
    key: string
  ) => Promise<StephenTurn>;
}

/** A turn, as the page reads its stream: the whole turn, or why it failed. */
const turnOf = async (response: Response): Promise<StephenTurn> => {
  if (!response.ok) {
    throw await refusalOf(response, "Stephen's turn");
  }
  const { events } = turnEvents(`${await response.text()}\n`);
  for (const event of events) {
    if ("turn" in event) {
      return event.turn;
    }
    if ("error" in event) {
      throw new CoreCallError(`Stephen's turn: ${event.error}`, event.status);
    }
  }
  throw new CoreCallError("Stephen's turn ended without a turn.", 502);
};

/** Someone's link on the local core. */
export const linkOn = (link: string): Link => {
  const secret = secretOf(link);
  return {
    open: async (key) =>
      sessionSchema.parse(
        await interviewCall({
          action: "session",
          secret,
          ...(key === undefined ? {} : { key }),
        })
      ),
    save: async (key, version, progress) => {
      const saved = savedSchema.parse(
        await interviewCall({ action: "save", secret, key, version, progress })
      );
      if (!saved.saved) {
        throw new CoreCallError(
          "Someone else saved this interview meanwhile.",
          409
        );
      }
      return saved.version;
    },
    turn: async (request, key) =>
      await whileBusy(
        async () =>
          await turnOf(
            await fetch(new URL(interviewTurnPath, origin), {
              method: "POST",
              headers: { origin, "content-type": "application/json" },
              body: JSON.stringify({ ...request, secret, key }),
            })
          )
      ),
  };
};

/** Runs `work` for every item, at most `limit` at a time, keeping their order. */
export const inTurns = async <T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    results.push(
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      ...(await Promise.all(items.slice(index, index + limit).map(work)))
    );
  }
  return results;
};
