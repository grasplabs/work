import type { ComposioToolRule, ToolClass } from "@grasp-os/shared/connect";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { composioClasses as shipped } from "../src/composio-classes.ts";
import { fakeComposioApi } from "./composio-api.ts";
import {
  addConnection,
  agentFor,
  callAs,
  chatOrigin,
  outcome,
  someone,
} from "./connect.ts";
import type { FakeTool } from "./mcp-server.ts";

// Every toolkit this release reviewed, by its own tools (src/composio-
// classes.ts), against the fake Composio: Stephen reads where the admin
// pointed him and nowhere else, a change waits for its person's card, and
// a tool nobody classed is never offered or run. HubSpot's tools are the
// fake's own in tests (test/fixtures/composio-classes.ts), and tested
// with them (composio-tools.test.ts).

/** The input property every tool here names its place in. */
const placeField = "place_id";

/** Where the admin points each connection here. */
const place = "place-1";

/** The first tool of `toolkit` a review gave one of `classes`. */
const firstOf = (
  toolkit: string,
  classes: readonly ToolClass[]
): string | undefined =>
  Object.entries(shipped[toolkit] ?? {})
    .toSorted(([first], [second]) => first.localeCompare(second))
    .find(([, toolClass]) => classes.includes(toolClass))?.[0];

/** Each reviewed toolkit, with a read, a change if it has one, and a tool nobody classed. */
const toolkits = Object.keys(shipped)
  .filter((toolkit) => toolkit !== "hubspot")
  .toSorted()
  .map((toolkit) => ({
    toolkit,
    read: firstOf(toolkit, ["read-own", "read-company"]),
    change: firstOf(toolkit, ["change-own", "change-company", "reach-others"]),
    unclassed: `${toolkit.toUpperCase()}_UNREVIEWED`,
  }));

/** A tool of Composio's server: it takes a place and a text, and says it ran. */
const served = (name: string): FakeTool => ({
  name,
  // Composio's own word, which connect never takes.
  readOnly: true,
  inputs: [placeField, "text"],
  run: (input) => ({ output: { ran: name, input } }),
});

const composio = fakeComposioApi([], {
  mcpTools: toolkits.flatMap(({ read, change, unclassed }) =>
    [read, change, unclassed].flatMap((name) =>
      name === undefined ? [] : [served(name)]
    )
  ),
});

describe("each Composio toolkit this release reviewed", () => {
  it("has a read to point Stephen at", () => {
    expect(toolkits.filter(({ read }) => read === undefined)).toStrictEqual([]);
  });

  it.each(toolkits)(
    "$toolkit: reads where the admin pointed him, refuses anywhere else, holds a change for a card and never offers what nobody classed",
    async ({ toolkit, read, change, unclassed }) => {
      if (read === undefined) {
        throw new Error(`${toolkit} has no read`);
      }
      const pointed = (name: string, isRead: boolean): ComposioToolRule => ({
        name,
        read: isRead,
        resource: placeField,
        places: [place],
      });
      const rules: ComposioToolRule[] = [
        pointed(read, true),
        ...(change === undefined ? [] : [pointed(change, false)]),
        { name: unclassed, read: true },
      ];
      const connectionId = await addConnection({
        provider: toolkit,
        server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_1`,
        tools: JSON.stringify(rules),
      });
      const anna = someone();
      const inChat = agentFor(anna.userId, "agent-chat", "interactive");
      const call = async (action: string, at: string) =>
        await callAs(
          inChat,
          {
            connectionId,
            action,
            input: { [placeField]: at, text: "status" },
            idempotencyKey: crypto.randomUUID(),
          },
          { origin: chatOrigin }
        );
      const there = await outcome(call(read, place));
      const elsewhere = await outcome(call(read, "place-2"));
      const neverClassed = await outcome(call(unclassed, place));
      const changed =
        change === undefined ? undefined : await call(change, place);
      const listed = await exports.default.listConnections(anna);
      const connection = listed.find(({ id }) => id === connectionId);
      const pending = await exports.default.listPendingActions(anna);
      expect({
        there,
        elsewhere,
        neverClassed,
        changed:
          changed === undefined || changed.pending !== undefined
            ? "held"
            : "ran",
        pending: pending.map(({ action }) => action),
        offered: connection?.offeredTools,
        ran: composio.state.mcp.ran.map(({ tool }) => tool),
      }).toStrictEqual({
        there: "ok",
        elsewhere: "connect.place_out_of_scope",
        neverClassed: "connect.action_not_found",
        changed: "held",
        pending: change === undefined ? [] : [change],
        offered: change === undefined ? [read] : [read, change],
        ran: [read],
      });
    }
  );
});
