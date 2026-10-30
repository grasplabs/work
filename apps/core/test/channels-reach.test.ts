import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import {
  kept,
  member,
  messageFrom,
  post,
  reached,
  watched,
} from "./teams-door.ts";

// Settings › Stephen at the door (src/channels/door.ts): a member he
// doesn't reach, in Teams or at all, is told so in one line, and nothing
// they wrote is read or answered; once he reaches them, they are.

const idp = mockIdp();

watched();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const notTurnedOn =
  "Your company hasn't turned me on for you yet. If you'd like to use me, ask your admin.";

describe("a member Stephen doesn't reach", setUpTime, () => {
  it("is told so, and nothing is read, until he reaches them again", async () => {
    const admin = await signedInApi(idp, "admin");
    const { userId, teams, provider } = await member(idp, says("Hello."));
    try {
      await admin.api.connections.setStephenReach(false, { who: "everyone" });
      await post(messageFrom(teams, { text: "Anyone there?" }));

      await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
      const { lines } = await reached(teams.conversation);
      expect({ lines, asked: provider.requests.length }).toStrictEqual({
        lines: [notTurnedOn],
        asked: 0,
      });
    } finally {
      await admin.api.connections.setStephenReach(true, { who: "everyone" });
    }

    await post(messageFrom(teams, { text: "Anyone there now?" }));

    await expect(kept(teams.conversation)).resolves.toStrictEqual([
      { platform: "teams", userId },
    ]);
    expect(provider.requests).toHaveLength(1);
  });

  it("is told so when Teams is narrowed to people they aren't among", async () => {
    const admin = await signedInApi(idp, "admin");
    const { teams, provider } = await member(idp);
    // A team of nobody: the member isn't in it.
    const team = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Sales', 'organization', ?)"
    )
      .bind(team, Date.now())
      .run();
    try {
      await admin.api.connections.setStephenPlace(
        "teams",
        { who: "teams", teams: [team] },
        true
      );
      await post(messageFrom(teams));

      const { lines } = await reached(teams.conversation);
      expect({ lines, asked: provider.requests.length }).toStrictEqual({
        lines: [notTurnedOn],
        asked: 0,
      });
    } finally {
      await admin.api.connections.setStephenPlace(
        "teams",
        { who: "asStephen" },
        true
      );
    }
  });
});
