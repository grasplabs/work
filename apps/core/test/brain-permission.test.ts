import { describe, expect, it } from "vite-plus/test";

import { actingFor, envOf } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The Brain's permission (`brain`, a platform action): the grant Apps and
// runs read the company Brain under. An agent reads the Brain with none
// (GRA-2203), so it is never granted one, nor any other of the platform's
// offers, which stay an App's.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

describe("the Brain's permission", setUpTime, () => {
  it("is never granted to an agent, which reads the Brain with none, and nor is any other offer of the platform", async () => {
    const admin = await signedInApi(idp, "admin");
    const agent = newAgent();
    const asked = async (action: "brain" | "statistics") =>
      await outcome(
        admin.api.permissions.request({
          subject: agent,
          object: { type: "platform" },
          actions: [action],
          binding: "PLATFORM",
        })
      );
    const env = await envOf(actingFor(agent, admin.userId));
    expect({
      brain: await asked("brain"),
      statistics: await asked("statistics"),
      stubs: Object.keys(env),
    }).toStrictEqual({
      brain: "permission.invalid",
      statistics: "permission.invalid",
      stubs: [],
    });
  });
});
