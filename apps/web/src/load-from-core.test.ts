import { internalErrors } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { CoreConnection } from "./core-connection.ts";
import { loadFromCore, notLoadedText } from "./load-from-core.tsx";

// What a page says when its read from core fails, over the tab's real
// connection to a stand-in core: a read the connection drops under is core
// out of reach, as one that never got a connection is, and never shows
// the socket's own words; what core answers stays core's reason.

/** A stand-in core whose page read ends as `read` does. */
const tabWhoseRead = (read: () => Promise<unknown>): CoreConnection =>
  new CoreConnection({
    onSessionEnded: () => {
      // Nobody signs out here.
    },
    connect: () => {
      const session = {
        whoami: async () => await Promise.resolve({ userId: "one" }),
        chats: { list: read },
      };
      const stub = {
        authenticate: async () => await Promise.resolve(session),
        onRpcBroken: () => {
          // Read failures here are the read's own.
        },
        [Symbol.dispose]: () => {
          // Nothing to let go of.
        },
      };
      // SAFETY: a stand-in for the parts of core's API the page reads.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return stub as never;
    },
    watchPage: () => {
      // The page never comes back here.
    },
  });

/** What the page says of a read that ends as `read` does. */
const shown = async (read: () => Promise<unknown>) => {
  const page = await loadFromCore(
    tabWhoseRead(read),
    async (session) => await session.chats.list()
  );
  return { state: page.state, text: notLoadedText(page, i18n) };
};

describe("a page's read from core", () => {
  beforeAll(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });

  it("says core can't be reached when the connection drops under it, never the socket's words", async () => {
    const dropped = await shown(async () => {
      // As Cap'n Web rejects what was on its way when the socket closes.
      await Promise.resolve();
      throw new Error("Peer closed WebSocket: 0");
    });

    expect(dropped).toStrictEqual({
      state: "offline",
      text: "Grasp can't be reached right now. Try again in a moment.",
    });
  });

  it("still says why when core answers with a refusal, or fails", async () => {
    const refused = await shown(async () => {
      await Promise.resolve();
      throw roleErrors.create("role.forbidden");
    });
    const failed = await shown(async () => {
      await Promise.resolve();
      throw internalErrors.create("internal.unexpected");
    });

    expect([refused.state, failed.state]).toStrictEqual(["refused", "refused"]);
    expect(refused.text).not.toContain("can't be reached");
    expect(failed.text).not.toContain("can't be reached");
  });
});
