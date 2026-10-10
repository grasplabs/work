import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// People's own dashboards, through `/rpc` as the frontend reaches them:
// which of the board's widgets are on it, in what order, kept in each
// person's own Workspace object. The ways it can fail come first:
// someone else reads or changes a person's board; a board with every
// widget taken off reads as never saved, so everything comes back; a
// saved order comes back shuffled; a page saves widgets there are none
// of, or one twice.

const idp = mockIdp();

/** Someone signed in on a connection of their own, and their dashboard. */
const person = async () => {
  const signedIn = await signedInApi(idp, "user");
  return { ...signedIn, dashboard: signedIn.api.dashboard };
};

describe("a person's dashboard", () => {
  it("is none until they save one, then theirs as saved, in order", async () => {
    const { dashboard } = await person();
    await expect(dashboard.layout()).resolves.toBeNull();

    await dashboard.saveLayout({ widgets: ["runs", "workflows", "signals"] });
    await expect(dashboard.layout()).resolves.toStrictEqual({
      widgets: ["runs", "workflows", "signals"],
    });

    // Saving again replaces the whole board.
    await dashboard.saveLayout({ widgets: ["engines", "runs"] });
    await expect(dashboard.layout()).resolves.toStrictEqual({
      widgets: ["engines", "runs"],
    });
  });

  it("keeps a board with every widget taken off as empty, not as never saved", async () => {
    const { dashboard } = await person();
    await dashboard.saveLayout({ widgets: [] });
    await expect(dashboard.layout()).resolves.toStrictEqual({ widgets: [] });
  });

  it("is each person's own: another's stays as it was", async () => {
    const ann = await person();
    const bob = await person();
    await ann.dashboard.saveLayout({ widgets: ["signals"] });

    await expect(bob.dashboard.layout()).resolves.toBeNull();
    await bob.dashboard.saveLayout({ widgets: ["workflows", "engines"] });
    await expect(ann.dashboard.layout()).resolves.toStrictEqual({
      widgets: ["signals"],
    });
  });

  it("refuses widgets there are none of, one twice, or anything but a board, and keeps what was saved", async () => {
    const { dashboard } = await person();
    await dashboard.saveLayout({ widgets: ["engines"] });
    const save = async (layout: unknown) =>
      await outcome(
        dashboard.saveLayout(
          // SAFETY: invalid on purpose: anything a client can send, as Cap'n
          // Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          layout as never
        )
      );

    expect({
      unknown: await save({ widgets: ["workflows", "weather"] }),
      twice: await save({ widgets: ["runs", "runs"] }),
      tooMany: await save({
        widgets: ["workflows", "engines", "runs", "signals", "workflows"],
      }),
      noList: await save({ widgets: "runs" }),
      more: await save({ widgets: ["runs"], owner: "someone-else" }),
      nothing: await save(null),
    }).toStrictEqual({
      unknown: "dashboard.invalid_layout",
      twice: "dashboard.invalid_layout",
      tooMany: "dashboard.invalid_layout",
      noList: "dashboard.invalid_layout",
      more: "dashboard.invalid_layout",
      nothing: "dashboard.invalid_layout",
    });
    await expect(dashboard.layout()).resolves.toStrictEqual({
      widgets: ["engines"],
    });
  });
});
