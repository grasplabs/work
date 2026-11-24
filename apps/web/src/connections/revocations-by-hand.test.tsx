// @vitest-environment happy-dom
import type { RevocationToDo } from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { Loaded } from "../load-from-core.tsx";
import { RevocationsByHand } from "./revocations-by-hand.tsx";

// Access at an app Grasp couldn't remove, shown to admins with what to do.
// From the ways it can fail: a warning that silently goes when its read
// fails, as if there were nothing to remove; a former member's access
// left to "ask" someone no longer here.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const toDo = (change: Partial<RevocationToDo> = {}): RevocationToDo => ({
  id: "r1",
  connectionId: "c1",
  provider: "google",
  scope: "personal",
  state: "given_up",
  owedFor: "disconnected",
  since: "2026-10-01T08:00:00.000Z",
  attempts: 9,
  givenUpAt: "2026-10-20T08:00:00.000Z",
  reason: "expired",
  accountName: null,
  ownerUserId: "u1",
  ownerName: "Ada",
  ownerIsMember: true,
  ...change,
});

let root: Root | undefined;

/** The section's text, shown with `loaded`. */
const shown = async (loaded: Loaded<RevocationToDo[]>): Promise<string> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RevocationsByHand
          nameOf={() => "Google Workspace"}
          toDos={Promise.resolve(loaded)}
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return host.textContent ?? "";
};

describe("the access to remove by hand", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("asks a member to remove it at the app themselves", async () => {
    await expect(shown({ state: "ready", data: [toDo()] })).resolves.toContain(
      "Ask Ada to remove Grasp"
    );
  });

  it("sends a former member's, their name still known, to the app's admin settings", async () => {
    const text = await shown({
      state: "ready",
      data: [toDo({ ownerIsMember: false })],
    });
    expect({
      former: text.includes("former member"),
      ask: text.includes("Ask Ada"),
    }).toStrictEqual({ former: true, ask: false });
  });

  it("says it couldn't be read, rather than showing nothing", async () => {
    const text = await shown({ state: "offline" });
    expect({
      section: text.includes("Access to remove by hand"),
      unreachable: text.includes("can't be reached"),
    }).toStrictEqual({ section: true, unreachable: true });
  });

  it("shows nothing while there is nothing to remove", async () => {
    await expect(shown({ state: "ready", data: [] })).resolves.toBe("");
  });
});
