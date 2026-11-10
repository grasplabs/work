import { describe, expect, it } from "vite-plus/test";

import { reconcileUnsyncedTools } from "../src/composio-connections.ts";
import {
  changeTo,
  drawnWalks,
  setUp,
  walkAll,
} from "./composio-connections-harness.ts";

// Connecting a Composio toolkit: an admin consents to Composio holding its
// tokens, connects at Composio's auth link, and comes back with one shared
// connection, to an MCP server Composio made for that toolkit's auth
// config, that one account and only the tools the admin allowed. Calls on
// it reach only those tools, with connect's key; its consent is in the
// audit log with who gave it; and whatever didn't finish is deleted at
// Composio again.

describe("Composio's tool list through crashes", () => {
  it("keeps two changes and the clock's reconcile in step, crashing anywhere", async () => {
    const { admin, connectionId, serverId } = await setUp();
    const wrong = await drawnWalks(
      connectionId,
      serverId,
      {
        a: changeTo(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"]),
        r: async (actorEnv) => {
          await reconcileUnsyncedTools(actorEnv);
        },
        b: changeTo(admin, connectionId, [
          "HUBSPOT_LIST_CONTACTS",
          "HUBSPOT_UPDATE_CONTACT",
        ]),
      },
      {
        fixed: [
          ["b", "a", "r", "a", "r", "b", "r", "r", "b", "b", "a", "r", "b"],
          // A narrowing lands after the other change's reconcile, and is
          // answered before that reconcile settles.
          "r a r r r r r r a b b b b b b r b a a b r a b b".split(" "),
        ],
        seed: 993,
        // Every order of three is past running: many more drawn instead.
        count: walkAll ? 20_000 : 600,
        longest: 24,
      }
    );

    expect(wrong).toStrictEqual([]);
  }, 3_600_000);
});
