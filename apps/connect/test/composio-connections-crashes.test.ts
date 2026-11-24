import { describe, expect, it } from "vite-plus/test";

import { reconcileUnsyncedTools } from "../src/composio-connections.ts";
import {
  changeTo,
  drawnWalks,
  everyWalk,
  setUp,
  walkAll,
} from "./composio-connections-harness.ts";
import type { Actors } from "./composio-connections-harness.ts";

// Connecting a Composio toolkit: an admin consents to Composio holding its
// tokens, connects at Composio's auth link, and comes back with one shared
// connection, to an MCP server Composio made for that toolkit's auth
// config, that one account and only the tools the admin allowed. Calls on
// it reach only those tools, with connect's key; its consent is in the
// audit log with who gave it; and whatever didn't finish is deleted at
// Composio again.

describe("Composio's tool list through crashes", () => {
  it("keeps a change and the clock's reconcile in step, crashing anywhere", async () => {
    const { admin, connectionId, serverId } = await setUp();
    const actors: Actors = {
      a: changeTo(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"]),
      r: async (actorEnv) => {
        await reconcileUnsyncedTools(actorEnv);
      },
    };
    const wrong = walkAll
      ? await everyWalk(connectionId, serverId, actors)
      : await drawnWalks(connectionId, serverId, actors, {
          fixed: [
            // The narrowing, answered, crashes before the change's write:
            // Composio narrower than connect.
            ["a", "a"],
            // The clock counts its send while the narrowing is unanswered;
            // the narrowing lands after the clock's.
            ["a", "a", "r", "r", "r", "a", "r", "r"],
            // The clock counts and reads between the change's count and
            // its unanswered row.
            ["a", "r", "r", "r", "a", "r", "r", "a"],
          ],
          seed: 993,
          count: 800,
          longest: 14,
        });

    expect(wrong).toStrictEqual([]);
  }, 600_000);
});
