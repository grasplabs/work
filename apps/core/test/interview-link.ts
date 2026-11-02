import { errorPayloadSchema } from "@grasp-os/shared/errors";
import {
  factRevision,
  interviewApiPath,
  participationNotice,
} from "@grasp-os/shared/interview-links";
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";
import { routed, unique } from "./sign-in.ts";

// What the tests of an interview's endpoints share (interview-turn.test.ts,
// interview-story.test.ts): someone's link, opened on a device, and the
// organization's provider with Stephen's two models, faked behind connect
// (test/model-provider.ts).

/** The organization's default: both roles resolve to it. */
export const quick = "anthropic/claude-sonnet-4-5";
/** Its fallback. */
export const careful = "anthropic/claude-opus-4-8";

/** The models the organization chose for these tests: its default first. */
export const interviewModels = [quick, careful] as const;

const dayMs = 24 * 60 * 60 * 1000;

/** What a session answers, as far as these tests read it: the device's key. */
const sessionKey = z.object({ key: z.string().optional() });
/** A provider request, as far as these tests read it: its model. */
const requestModel = z.object({ model: z.unknown() });

/** A refusal's status and code. */
export const codeOf = async (response: Response) => {
  const parsed = errorPayloadSchema.safeParse(await response.json());
  return [response.status, parsed.success ? parsed.data.code : null];
};
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A link as the page holds it: its secret and the device's key. */
export interface Device {
  secret: string;
  key: string;
}

/** One of the link's calls, as the page makes it. */
export const onLink = async (body: unknown): Promise<Response> =>
  await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** They agree to take part, to the notice as it is now (or `notice`). */
export const participate = async (
  device: Device,
  notice: number = participationNotice.version
): Promise<Response> =>
  await onLink({ action: "participate", ...device, notice });

/** Each fact not taken out, at its revision as it stands: what approving it names. */
export const revisionsOf = async (
  facts: readonly InterviewFact[]
): Promise<{ id: string; revision: string }[]> =>
  await Promise.all(
    facts
      .filter(({ out }) => out !== true)
      .map(async (fact) => ({
        id: fact.id,
        revision: await factRevision(fact),
      }))
  );

/** They approve `facts` as they stand: each at its revision. */
export const approve = async (
  device: Device,
  facts: readonly InterviewFact[]
): Promise<Response> =>
  await onLink({
    action: "approve",
    ...device,
    facts: await revisionsOf(facts),
  });

/**
 * What a page does once someone agreed to the read-back: takes part, if it
 * didn't yet, and approves the facts it marked agreed, as they stand.
 */
export const approveAgreed = async (
  device: Device,
  facts: readonly InterviewFact[]
): Promise<void> => {
  await participate(device);
  const agreed = facts.filter(({ agreed: yes }) => yes === true);
  if (agreed.length > 0) {
    await approve(device, agreed);
  }
};

/**
 * A fresh onboarding running since yesterday, with one person in Ops (no
 * lead) whose link is out, opened on a device, and who agreed to take part
 * unless `participating` is false: their secret and key, and who they are.
 */
export const openedFor = async ({ participating = true } = {}) => {
  const store = onboardingStore(env);
  const person = `oli-${unique()}`;
  const roster: Roster = {
    teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
    people: [
      {
        id: person,
        name: "Oli Olsen",
        team: "ops",
        email: "",
        title: "",
        away: false,
      },
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const link = await store.linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await session.json());
  const device = { secret, key: key ?? "" };
  if (participating) {
    await participate(device);
  }
  return { link: device, person };
};

/** The same, as the page holds it: the link's secret and the device's key. */
export const opened = async () => {
  const { link } = await openedFor();
  return link;
};

/** The model a request went to, by its id in pi's catalog. */
export const modelOf = ({ body }: SentRequest): unknown =>
  requestModel.safeParse(body).data?.model;

/**
 * What `run` returns while the organization's provider answers each
 * request as `respond` says, from those so far; once `run` is done, it
 * answers none.
 */
export const answeringWith = async <T>(
  respond: (
    requests: readonly SentRequest[]
  ) => ProviderReply | undefined | Promise<ProviderReply | undefined>,
  run: () => Promise<T>
) => {
  let done = false;
  const fake = await answeringProvider(
    async (requests) => (done ? undefined : await respond(requests)),
    { models: interviewModels }
  );
  try {
    return { requests: fake.requests, result: await run() };
  } finally {
    done = true;
  }
};

/** What `run` returns while the organization's provider answers with `replies`. */
export const answering = async <T>(
  replies: ProviderReply[],
  run: () => Promise<T>
) => await answeringWith(() => replies.shift(), run);

/** What the onboarding counted of interviews for `model`: calls and tokens read. */
export const countedFor = async (model: string) => {
  const rows = await onboardingStore(env).usage();
  const of = rows.filter(
    (row) => row.purpose === "interviews" && row.model === model
  );
  return {
    calls: of.reduce((sum, { calls }) => sum + calls, 0),
    tokensIn: of.reduce((sum, { tokensIn }) => sum + tokensIn, 0),
  };
};

/**
 * Holds the store's own alarm for a test that draws what is due and gives
 * a team to the brain itself, step by step, as the alarm would (`drawNext`,
 * `intakeNext`). Agreeing, deleting or drawing sets the alarm half a second
 * on, and on a slow runner it got there first: it drew outside the test's
 * faked provider, so the drawing failed and waited a minute to be tried
 * again, or it took a provider reply queued for the test's own drawing, or
 * its `model.call` landed amid the test's audit events, or it
 * gave the team to the brain before the test did. Deleting the alarm isn't
 * enough: the next agreement or drawing sets it again, and one already
 * going runs on.
 */
export const holdAlarm = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), (instance) => {
    vi.spyOn(instance, "alarm").mockResolvedValue();
  });
};
