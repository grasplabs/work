import { describe, expect, it } from "vite-plus/test";

import { requestGranted } from "./apps.ts";
import { actingFor, envOf } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The Brain's permission (`brain`, a platform action): the one grant Apps,
// runs and agents share for reading the company Brain. Agents and Apps
// start without it. Of the platform's offers it is the only one an agent
// or an independent workflow may be granted; the others stay an App's.
// Until the Brain's adapters exist (GRA-296) a grant gives no stub at
// all, and never another offer's.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

describe("the Brain's permission", setUpTime, () => {
  it("can be granted to an agent, unlike the platform's other offers, and gives it no other offer's stub", async () => {
    const admin = await signedInApi(idp, "admin");
    const agent = newAgent();
    const statistics = await outcome(
      admin.api.permissions.request({
        subject: agent,
        object: { type: "platform" },
        actions: ["statistics"],
        binding: "PLATFORM",
      })
    );
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const env = await envOf(actingFor(agent, admin.userId));
    expect({
      statistics,
      stubs: Object.keys(env).filter((name) => name !== "BRAIN_DB"),
    }).toStrictEqual({
      statistics: "permission.invalid",
      stubs: [],
    });
  });
});
