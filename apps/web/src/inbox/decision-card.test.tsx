// @vitest-environment happy-dom
import { decisionErrors } from "@grasp-os/shared/decisions";
import type { DecisionView } from "@grasp-os/shared/decisions";
import {
  runIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
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

import { DecisionCard } from "./decision-card.tsx";

// A decision's card when what it asks becomes withheld while it is open
// (GRA-1988), against core's `decisions` faked as core answers: an
// approval is refused (`decision.withheld`), and the decision read again,
// or reviewed, is the withheld one. The card shows what core serves now:
// the prompt it showed is gone, the note says why, and only Reject is left.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The prompt the card shows before its ask is withheld. */
const prompt = "Pay Globex the 50,000 it asked for?";

/** The decision as core serves it while its run may read what it read. */
const asked: DecisionView = {
  id: "decision-1",
  workflowResource: {
    id: workflowResourceIdSchema.parse("wr-1"),
    name: "invoices",
  },
  workflow: workflowIdSchema.parse("invoices"),
  run: runIdSchema.parse("run-1"),
  description: prompt,
  input: { supplier: "Globex", amount: 50_000 },
  status: "open",
  expiresAt: "2026-11-20T09:00:00.000Z",
  revision: "revision-asked",
};

const { input: _input, ...unasked } = asked;

/** The same decision once withheld, as core serves it then: no input. */
const withheld: DecisionView = {
  ...unasked,
  description:
    "What this decision asks is withheld: the run that asked it may no longer read what it read.",
  withheld: "revoked",
  revision: "revision-withheld",
};

/** The same decision while its run's evidence can't be checked. */
const unchecked: DecisionView = {
  ...unasked,
  description:
    "What this decision asks can't be shown right now. Try again in a moment.",
  withheld: "unchecked",
  revision: "revision-unchecked",
};

/** The note the card shows for a withheld decision. */
const note = "What this decision asks is withheld, so you can only reject it.";

/** The note it shows while what it asks can't be checked. */
const uncheckedNote =
  "What this decision asks can't be shown right now, so it can't be answered yet. Try again in a moment.";

/** Lets renders and the faked core's answers settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/**
 * Shows the card on a faked core whose `decisions` are `api`, for the
 * decision its page's loader gives, `asked` at first, as the decision's
 * own page does; `give` loads the page again on another.
 */
const shown = async (api: Readonly<Record<string, unknown>>) => {
  const core = {
    withSession: async <T,>(
      action: (session: { decisions: typeof api }) => Promise<T>
    ): Promise<T> => await action({ decisions: api }),
  };
  let given = asked;
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    loader: () => given,
    component: () => <DecisionCard decision={page.useLoaderData()} />,
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
  await settle();
  return {
    give: async (decision: DecisionView): Promise<void> => {
      given = decision;
      await act(async () => {
        await router.invalidate();
      });
      await settle();
    },
  };
};

/** Waits `ms`, letting renders settle: past the dialog's delay. */
const waited = async (ms: number): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, ms);
    await promise;
  });
  await settle();
};

/** The card's answer buttons, by their text. */
const answerButtons = (): string[] =>
  [...document.querySelectorAll("button")]
    .map((button) => button.textContent.trim())
    .filter((text) => text === "Approve" || text === "Reject");

/** Presses the button whose text is `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === label
  );
  if (!button) {
    throw new TypeError(`No ${label} button`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** What the person sees of the card. */
const seen = () => {
  const text = document.body.textContent;
  return {
    prompt: text.includes(prompt),
    about: text.includes("Globex"),
    note: text.includes(note),
    uncheckedNote: text.includes(uncheckedNote),
    comment: document.querySelector("textarea") !== null,
    buttons: answerButtons(),
  };
};

describe("a decision's card, its ask withheld while it is open", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows the decision as core serves it now once an approval is refused: the prompt gone, the note, Reject alone", async () => {
    await shown({
      review: async (_id: string, answer: { approved: boolean }) => {
        if (answer.approved) {
          throw decisionErrors.create("decision.withheld");
        }
        return await Promise.resolve({
          state: "review",
          decision: withheld,
          response: answer,
        });
      },
      get: async () => await Promise.resolve(withheld),
    });
    const before = seen();

    await press("Approve");

    expect({ before, after: seen() }).toStrictEqual({
      before: {
        prompt: true,
        about: true,
        note: false,
        uncheckedNote: false,
        comment: true,
        buttons: ["Approve", "Reject"],
      },
      // Its comment stays: a reason for rejecting goes with the rejection.
      after: {
        prompt: false,
        about: false,
        note: true,
        uncheckedNote: false,
        comment: true,
        buttons: ["Reject"],
      },
    });
  });

  it("shows what a review serves: a rejection reviewed once the ask is withheld shows the withheld decision behind its dialog", async () => {
    await shown({
      review: async (_id: string, answer: { approved: boolean }) =>
        await Promise.resolve({
          state: "review",
          decision: withheld,
          response: answer,
        }),
      get: async () => await Promise.resolve(withheld),
    });

    await press("Reject");

    expect(seen()).toStrictEqual({
      prompt: false,
      about: false,
      note: true,
      uncheckedNote: false,
      comment: true,
      buttons: ["Reject"],
    });
  });

  it("takes no answer while what it asks can't be checked, and shows it again once a read can", async () => {
    let checkable = false;
    await shown({
      review: async () => {
        await Promise.resolve();
        throw decisionErrors.create("decision.unavailable");
      },
      get: async () => await Promise.resolve(checkable ? asked : unchecked),
    });

    await press("Approve");
    const outage = seen();
    checkable = true;
    await press("Try again");

    expect({ outage, after: seen() }).toStrictEqual({
      outage: {
        prompt: false,
        about: false,
        note: false,
        uncheckedNote: true,
        comment: false,
        buttons: [],
      },
      after: {
        prompt: true,
        about: true,
        note: false,
        uncheckedNote: false,
        comment: true,
        buttons: ["Approve", "Reject"],
      },
    });
  });

  it("shows the decision as core serves it once a confirmed approval is refused: the prompt gone, the note, Reject alone", async () => {
    await shown({
      review: async (_id: string, answer: { approved: boolean }) =>
        await Promise.resolve({
          state: "review",
          decision: asked,
          response: answer,
        }),
      confirm: async () => {
        await Promise.resolve();
        throw decisionErrors.create("decision.withheld");
      },
      get: async () => await Promise.resolve(withheld),
    });

    await press("Approve");
    // Past the confirmation's delay.
    await waited(1100);
    await press("Confirm");

    expect(seen()).toStrictEqual({
      prompt: false,
      about: false,
      note: true,
      uncheckedNote: false,
      comment: true,
      buttons: ["Reject"],
    });
  });

  it("shows nothing of what it asked, and takes no answer, once it can't be read again after a refusal", async () => {
    await shown({
      review: async () => {
        await Promise.resolve();
        throw decisionErrors.create("decision.withheld");
      },
      get: async () => {
        await Promise.resolve();
        throw new Error("Core can't be reached");
      },
    });

    await press("Approve");
    const refused = seen();
    // Why it was refused, until trying again says why that failed.
    const why = document.body.textContent.includes("it can only be rejected");
    await press("Try again");

    const unreadable = {
      prompt: false,
      about: false,
      note: false,
      uncheckedNote: true,
      comment: false,
      buttons: [],
    };
    expect({
      refused,
      why,
      tried: seen(),
    }).toStrictEqual({ refused: unreadable, why: true, tried: unreadable });
  });

  it("shows the decision a fresh load gives, not the one it was given before", async () => {
    const revised: DecisionView = {
      ...asked,
      description: "Pay Initech the 12,000 it asked for?",
      revision: "revision-revised",
    };
    const page = await shown({});

    await page.give(revised);
    const text = document.body.textContent;

    expect({
      revised: text.includes("Pay Initech the 12,000 it asked for?"),
      before: text.includes(prompt),
    }).toStrictEqual({ revised: true, before: false });
  });
});
