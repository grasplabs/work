import { unknownOutcomeListLimit } from "@grasp-os/shared/connect";
import type { UnknownOutcomeListing } from "@grasp-os/shared/connect";
import { appIdSchema, connectionIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { readOutcomes } from "./everyones-outcomes.ts";

// Everyone's open calls of unknown outcome, as an admin's inbox reads them
// (everyones-outcomes.ts): core audits each page it lists, so once the
// inbox is left no page more is asked for.

/** A full first page of calls, then one more: two pages in all. */
const pageOf = (page: number): UnknownOutcomeListing[] =>
  Array.from(
    { length: page === 1 ? unknownOutcomeListLimit : 1 },
    (_, index) => ({
      id: `${page}.${index}`,
      effectKeyHash: "0".repeat(64),
      onBehalfOf: "user-bo",
      subject: { type: "app", appId: appIdSchema.parse("app-invoices") },
      connectionId: connectionIdSchema.parse("connection-1"),
      connectionName: "Slack (ops)",
      action: "post_message",
      resource: null,
      sentAt: "2026-10-13T08:00:00.000Z",
      cursor: `${page}.${index}`,
    })
  );

describe("everyone's open calls of unknown outcome", () => {
  it("asks for no page more once the inbox is left", async () => {
    const left = new AbortController();
    let pages = 0;
    const reads = {
      unknownOutcomes: {
        listAll: async () => {
          pages += 1;
          // The person leaves the inbox while the first page is read.
          left.abort();
          return await Promise.resolve(pageOf(pages));
        },
      },
      members: { list: async () => await Promise.resolve([]) },
    };
    // SAFETY: a session with only the two reads `readOutcomes` makes.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const blank = {} as Session;
    const session = Object.assign(blank, reads);
    // Typed as the connection's, not as a generic literal of its own.
    const core: Pick<CoreConnection, "withSession"> = {
      withSession: async (read) => await read(session),
    };
    const read = await readOutcomes(core, "user-ada", left.signal);
    expect({ state: read.state, pages }).toStrictEqual({
      state: "offline",
      pages: 1,
    });
  });
});
