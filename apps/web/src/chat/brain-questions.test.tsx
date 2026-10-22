// @vitest-environment happy-dom
import type { Gap } from "@grasp-os/shared/brain";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BrainQuestions } from "./brain-questions.tsx";

// The brain's open questions in its chat, against core's brain as the page
// reaches it over RPC, faked: a closed question isn't shown; a member
// answers in their own words; only the company's admins ask the owner;
// Grasp's staff do neither; a refusal is said and the draft kept.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const open: Gap = {
  id: "gap-open",
  question: "How many invoices come in a month?",
  owner: "Head of finance",
  sourceId: "src-1",
  about: [],
};
const closed: Gap = {
  id: "gap-closed",
  question: "Who approves a refund?",
  owner: "Head of finance",
  sourceId: "src-1",
  about: [],
  closedAt: "2026-10-21",
  answer: "Ann",
};

type Who = Pick<Identity, "role" | "staff">;

/** Shows `gaps` to `who`, on a core that refuses what `refusal` says. */
const shown = async (gaps: Gap[], who: Who, refusal?: string) => {
  const calls: string[] = [];
  const changed: number[] = [];
  const refuse = (): void => {
    if (refusal !== undefined) {
      throw new Error(refusal);
    }
  };
  const brain = {
    answerGap: async (id: string, answer: string) => {
      await Promise.resolve();
      calls.push(`answer ${id}: ${answer}`);
      refuse();
    },
    askAboutGap: async (id: string) => {
      await Promise.resolve();
      calls.push(`ask ${id}`);
      refuse();
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { brain: typeof brain }) => Promise<T>
    ): Promise<T> => await action({ brain }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <BrainQuestions
        gaps={gaps}
        identity={who}
        onChanged={() => {
          changed.push(1);
        }}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  return { calls, changed };
};

/** The buttons shown, by label. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map((each) => each.textContent);

/** Presses the button labelled `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent === label
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};

/** Types `text` into the answer box. */
const write = async (text: string): Promise<void> => {
  const box = document.querySelector("textarea");
  if (!box) {
    throw new TypeError("No answer box");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

describe(BrainQuestions, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lets a member answer an open question in their own words, and shows no closed one", async () => {
    const { calls, changed } = await shown([closed, open], {
      role: "user",
      staff: false,
    });
    const before = {
      text: document.body.textContent,
      buttons: buttons(),
    };

    await press("Answer");
    await write("About 400.");
    await press("Send answer");

    expect({
      closedShown: before.text.includes(closed.question),
      openShown: before.text.includes(open.question),
      buttons: before.buttons,
      calls,
      changed: changed.length,
    }).toStrictEqual({
      closedShown: false,
      openShown: true,
      buttons: ["Answer"],
      calls: ["answer gap-open: About 400."],
      changed: 1,
    });
  });

  it("lets the company's admin have the owner asked, once", async () => {
    const { calls } = await shown(
      [open, { ...open, id: "gap-asked", askedAt: "2026-10-21" }],
      { role: "admin", staff: false }
    );
    const before = buttons();

    await press("Ask Head of finance");

    expect({ before, calls }).toStrictEqual({
      before: ["Answer", "Ask Head of finance", "Answer"],
      calls: ["ask gap-open"],
    });
  });

  it("offers Grasp's staff neither, and nothing when no question is open", async () => {
    await shown([open], { role: "admin", staff: true });
    const staff = buttons();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([closed], { role: "user", staff: false });

    expect({ staff, empty: document.body.textContent }).toStrictEqual({
      staff: [],
      empty: "",
    });
  });

  it("says why core refused an answer, and keeps what was written", async () => {
    const { changed } = await shown(
      [open],
      { role: "user", staff: false },
      "That question is closed already."
    );

    await press("Answer");
    await write("About 400.");
    await press("Send answer");

    expect({
      said: document.body.textContent.includes("closed already"),
      kept: document.querySelector("textarea")?.value,
      changed: changed.length,
    }).toStrictEqual({ said: true, kept: "About 400.", changed: 0 });
  });
});
