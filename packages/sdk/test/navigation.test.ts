import { describe, expect, it } from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";
import type { ClientTransport } from "../src/client-core.ts";
import type { Id } from "../src/index.ts";
import { screens } from "./notes/.grasp/references.ts";

// Navigation between an App's screens (spec 10.7.7), as the session client
// asks the host for it: one of the App's generated screen references and
// its route input, normalized by the route's own schema before anything
// is sent, and left out only for an input that may be. Nothing else goes
// to the host: no URL, path, App or person. Whether the host may go there
// is core's (apps/core/test/screen-navigation.test.ts); the page's part,
// the web's screen-bridge tests.

// SAFETY: a note's ID as the App's IDs are written; no note need exist.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const noteId = "01890000-0000-7000-8000-000000000001" as Id<"notes">;

/** A client whose host records each navigation and leave guard it is told. */
const hosted = (navigation = true) => {
  const sent: unknown[] = [];
  const guards: boolean[] = [];
  const transport: ClientTransport = {
    call: async () => {
      await Promise.resolve();
      throw new Error("Nothing here calls the App.");
    },
    watch: async () => {
      await Promise.resolve();
      throw new Error("Nothing here follows a query.");
    },
    ...(navigation
      ? {
          navigation: {
            navigate: async (request: string) => {
              sent.push(JSON.parse(request));
              await Promise.resolve();
            },
            leaveGuard: (guarded: boolean) => {
              guards.push(guarded);
            },
          },
        }
      : {}),
  };
  return { client: new GraspClient(transport), sent, guards };
};

/** The code `promise` rejects with, or `ok`. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : String(error);
  }
};

/** `value` passed where the types refuse it, on purpose. */
const unchecked = (value?: unknown): never =>
  // SAFETY: invalid on purpose; the client must refuse it at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** `client.navigate`, typed to take anything, as App code can't call it. */
const looseNavigate = (
  client: GraspClient
): ((screen: unknown, input: unknown) => Promise<void>) =>
  // The same function: its implementation takes anything, and refuses at
  // run time what its types refuse.
  client.navigate;

describe("navigating to another of the App's screens", () => {
  it("asks the host for a screen by its route name, with its input as its schema normalizes it, pushing unless told to replace", async () => {
    const { client, sent } = hosted();
    await client.navigate(screens.note, { id: noteId });
    await client.navigate(screens.notes);
    await client.navigate(screens.note, { id: noteId }, { replace: true });
    expect(sent).toStrictEqual([
      { screen: "note", input: { id: noteId }, replace: false },
      { screen: "notes", input: {}, replace: false },
      { screen: "note", input: { id: noteId }, replace: true },
    ]);
  });

  it("refuses, sending nothing, what isn't a generated screen, input its route refuses, options it doesn't take, and a client with no host", async () => {
    const { client, sent } = hosted();
    const results = {
      missingInput: await outcome(client.navigate(screens.note, unchecked())),
      wrongInput: await outcome(
        client.navigate(screens.note, unchecked({ id: 7 }))
      ),
      extraInput: await outcome(
        client.navigate(screens.note, unchecked({ id: noteId, admin: true }))
      ),
      url: await outcome(looseNavigate(client)("https://evil.test", {})),
      path: await outcome(looseNavigate(client)("/notes/n1", {})),
      forged: await outcome(
        looseNavigate(client)({ name: "note", path: "/notes/:id" }, {})
      ),
      replaceNotBoolean: await outcome(
        client.navigate(screens.notes, {}, unchecked({ replace: "yes" }))
      ),
      // `null` is input, not input left out, even for a screen taking none.
      nullInput: await outcome(client.navigate(screens.notes, unchecked(null))),
      noHost: await outcome(hosted(false).client.navigate(screens.notes)),
    };
    expect({ results, sent }).toStrictEqual({
      results: {
        missingInput: "contract.invalid_args",
        wrongInput: "contract.invalid_args",
        extraInput: "contract.invalid_args",
        url: "navigation.invalid_screen",
        path: "navigation.invalid_screen",
        forged: "navigation.invalid_screen",
        replaceNotBoolean: "contract.invalid_args",
        nullInput: "contract.invalid_args",
        noHost: "navigation.unavailable",
      },
      sent: [],
    });
  });

  it("asks the host for one of the screen's declared surfaces, with that surface's input normalized, never replacing", async () => {
    const { client, sent } = hosted();
    await client.navigate(screens.note, { id: noteId }, { surface: "beside" });
    await client.navigate(screens.notes, {}, { surface: "all" });
    expect(sent).toStrictEqual([
      { screen: "note", input: { id: noteId }, surface: "beside" },
      { screen: "notes", input: {}, surface: "all" },
    ]);
  });

  it("refuses, sending nothing, a surface the screen doesn't declare, a surface with replace, and input the surface refuses", async () => {
    const { client, sent } = hosted();
    const results = {
      otherScreens: await outcome(
        client.navigate(screens.notes, {}, unchecked({ surface: "beside" }))
      ),
      undeclared: await outcome(
        client.navigate(
          screens.note,
          { id: noteId },
          unchecked({ surface: "panel" })
        )
      ),
      prototypeName: await outcome(
        client.navigate(
          screens.note,
          { id: noteId },
          unchecked({ surface: "constructor" })
        )
      ),
      withReplace: await outcome(
        client.navigate(
          screens.note,
          { id: noteId },
          unchecked({ surface: "beside", replace: true })
        )
      ),
      wrongInput: await outcome(
        client.navigate(screens.note, unchecked({ id: 7 }), {
          surface: "beside",
        })
      ),
    };
    expect({ results, sent }).toStrictEqual({
      results: {
        otherScreens: "contract.invalid_args",
        undeclared: "contract.invalid_args",
        prototypeName: "contract.invalid_args",
        withReplace: "contract.invalid_args",
        wrongInput: "contract.invalid_args",
      },
      sent: [],
    });
  });

  it("is one function for the client's life", () => {
    const { client } = hosted();
    expect(client.navigate).toBe(client.navigate);
  });

  it("tells the host once whether anything holds unsaved edits, each time that changes", () => {
    const { client, guards } = hosted();
    const first = {};
    const second = {};
    client.guardLeave(first, true);
    client.guardLeave(second, true);
    client.guardLeave(first, false);
    client.guardLeave(first, false);
    client.guardLeave(second, false);
    client.guardLeave(second, true);
    expect(guards).toStrictEqual([true, false, true]);
  });
});
