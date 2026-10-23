import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { routed, unique } from "./sign-in.ts";

// What the tests of an interview's endpoints share (interview-turn.test.ts,
// interview-story.test.ts): someone's link, opened on a device, and the
// deployment's gateway with Stephen's two models, faked behind the AI
// binding.

export const quick = "anthropic/claude-sonnet-4-5";
export const careful = "anthropic/claude-opus-4-8";

/** The deployment's gateway: Stephen's two models, both let take sensitive data. */
export const gatewayConfig = {
  gateway: "grasp-os-test",
  models: [quick, careful],
  roles: { quick, careful },
  sensitive: { models: [quick, careful], connections: [] },
};

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

/**
 * A fresh onboarding running since yesterday, with one person in Ops (no
 * lead) whose link is out, opened on a device: their secret and key, and
 * who they are.
 */
export const openedFor = async () => {
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
  return { link: { secret, key: key ?? "" }, person };
};

/** The same, as the page holds it: the link's secret and the device's key. */
export const opened = async () => {
  const { link } = await openedFor();
  return link;
};

/** The model a request went to, by its id in pi's catalog. */
export const modelOf = ({ body }: GatewayRequest): unknown =>
  requestModel.safeParse(body).data?.model;

/** What `run` returns while the gateway answers with `replies`. */
export const answering = async <T>(
  replies: GatewayReply[],
  run: () => Promise<T>
) => {
  const before = env.MODEL_GATEWAY;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  env.MODEL_GATEWAY = gatewayConfig;
  try {
    return { requests: fake.requests, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
};

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
