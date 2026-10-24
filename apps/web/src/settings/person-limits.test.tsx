// @vitest-environment happy-dom
import type {
  PersonLimit,
  PersonLimits,
  PersonLimitSet,
  PersonLimitSubject,
} from "@grasp-os/shared/models";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PersonLimitsSection } from "./person-limits.tsx";

// The limits per person on Settings › AI spend, against core's models API
// as the page reaches it over RPC (the boundary from the web app), faked:
// it keeps what an admin sets and answers the page's next read with it,
// and refuses a monthly limit above Grasp's budget as core does.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const ada = { userId: "user-ada", name: "Ada Lovelace" };
const bea = { userId: "user-bea", name: "Bea Koster" };
const finance = { teamId: "team-finance", name: "Finance" };

/**
 * Core's limits, kept as an admin sets them. `ceiling` is Grasp's budget
 * as the page reads it; `budget` as core checks it, lower when Grasp
 * lowered it since the page read it.
 */
const fakeModels = (ceiling: number, budget = ceiling) => {
  const sets: { subject: PersonLimitSubject; limit: PersonLimit }[] = [];
  const stored = new Map<
    string,
    { subject: PersonLimitSubject; limit: PersonLimit }
  >();
  const nameOf = (subject: PersonLimitSubject): string | null => {
    if (subject.type === "person") {
      return (
        [ada, bea].find(({ userId }) => userId === subject.userId)?.name ?? null
      );
    }
    return subject.type === "team" ? finance.name : null;
  };
  const models = {
    limits: async (): Promise<PersonLimits> => {
      await Promise.resolve();
      return {
        month: "2026-10",
        default: stored.get('{"type":"default"}')?.limit ?? {
          monthly: 10,
          messagesAnHour: null,
        },
        exceptions: [...stored.values()].flatMap(({ subject, limit }) =>
          subject.type === "default"
            ? []
            : [{ subject, name: nameOf(subject), limit }]
        ),
        ceiling,
        people: [
          {
            ...ada,
            from: "default",
            limit: { monthly: 10, messagesAnHour: null },
            spent: 2.5,
          },
          {
            ...bea,
            from: "none",
            limit: { monthly: null, messagesAnHour: null },
            spent: 0.75,
          },
        ],
        more: false,
        teams: [finance],
      };
    },
    setLimit: async (
      subject: PersonLimitSubject,
      limit: PersonLimit
    ): Promise<PersonLimitSet> => {
      await Promise.resolve();
      sets.push({ subject, limit });
      if (limit.monthly !== null && limit.monthly > budget) {
        return { state: "above_budget", ceiling: budget };
      }
      stored.set(JSON.stringify(subject), { subject, limit });
      return { state: "set" };
    },
    removeLimit: async (subject: PersonLimitSubject): Promise<void> => {
      await Promise.resolve();
      stored.delete(JSON.stringify(subject));
    },
  };
  return { models, sets };
};

let root: Root | undefined;

/** The section on what `models` lists, for an admin when `editable`. */
const shown = async (
  models: ReturnType<typeof fakeModels>["models"],
  editable = true
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { models: typeof models }) => Promise<T>
    ): Promise<T> => await action({ models }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await models.limits(),
    component: () => (
      <PersonLimitsSection
        editable={editable}
        limits={rootRoute.useLoaderData()}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
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
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The buttons' names, by their label or their text. */
const buttonNames = (): string[] =>
  [...document.querySelectorAll("button")].map(
    (each) => each.getAttribute("aria-label") ?? each.textContent?.trim() ?? ""
  );

/** The button named `name`. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

/** The control labelled `label`. */
const field = (label: string): HTMLInputElement | HTMLSelectElement => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  const found = document.querySelector(`[id="${labelled?.htmlFor ?? ""}"]`);
  if (
    !(found instanceof HTMLInputElement || found instanceof HTMLSelectElement)
  ) {
    throw new TypeError(`No field ${label}`);
  }
  return found;
};

/** Sets `element` to `value`, as React hears a person type or choose it. */
const enter = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
): Promise<void> => {
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(element) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    await Promise.resolve();
  });
};

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** Adds an exception for `who` (`person:…` or `team:…`) with the values given. */
const addException = async (
  who: string,
  monthly: string,
  hourly: string
): Promise<void> => {
  await click(button("Add an exception"));
  await enter(field("Who"), who);
  await enter(field("Most a month, in US dollars"), monthly);
  await enter(field("Most messages an hour"), hourly);
  await click(button("Save"));
};

/** The section's rows of limits, as a person reads them. */
const limitRows = (): string[] =>
  [...document.querySelectorAll("section > ul:first-of-type > li")].map(
    (row) => row.querySelector("span")?.textContent?.trim() ?? ""
  );

const alertText = (): string | undefined =>
  document.querySelector('[role="alert"]')?.textContent ?? undefined;

describe("limits per person in Settings › AI spend", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets an admin set a person's limit and an exception for a team, then lists them", async () => {
    const { models, sets } = fakeModels(100);
    await shown(models);

    await addException(`person:${ada.userId}`, "20", "30");
    await addException(`team:${finance.teamId}`, "50", "");

    expect(sets).toStrictEqual([
      {
        subject: { type: "person", userId: ada.userId },
        limit: { monthly: 20, messagesAnHour: 30 },
      },
      {
        subject: { type: "team", teamId: finance.teamId },
        limit: { monthly: 50, messagesAnHour: null },
      },
    ]);
    expect(limitRows()).toStrictEqual([
      "Everyone without an exception$10.00 a month, no limit on messages",
      "Ada Lovelace$20.00 a month, 30 messages an hour",
      "Team Finance$50.00 a month, no limit on messages",
    ]);
    // The dialog closed once core took each.
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await click(button(`Remove the exception for ${ada.name}`));
    expect(limitRows()).toStrictEqual([
      "Everyone without an exception$10.00 a month, no limit on messages",
      "Team Finance$50.00 a month, no limit on messages",
    ]);
  });

  it("refuses a monthly limit above Grasp's budget with its reason, before asking core and when core refuses it", async () => {
    // Grasp lowered its budget to $40 after the page read $100.
    const { models, sets } = fakeModels(100, 40);
    await shown(models);

    await addException(`person:${bea.userId}`, "150", "");
    const beforeAsking = alertText();
    const askedBefore = sets.length;

    await enter(field("Most a month, in US dollars"), "60");
    await click(button("Save"));

    expect({
      beforeAsking,
      askedBefore,
      afterCore: alertText(),
      stillOpen: document.querySelector('[role="dialog"]') !== null,
      exceptions: limitRows().length - 1,
    }).toStrictEqual({
      beforeAsking:
        "Grasp's budget allows at most $100.00 a month for one person, so no limit can be above it. Ask Grasp to raise the budget first.",
      askedBefore: 0,
      afterCore:
        "Grasp's budget allows at most $40.00 a month for one person, so no limit can be above it. Ask Grasp to raise the budget first.",
      stillOpen: true,
      exceptions: 0,
    });
  });

  it("shows a non-admin the limits and each person's spend, with nothing to change", async () => {
    const { models } = fakeModels(100);
    await shown(models, false);
    expect({
      buttons: buttonNames(),
      rows: limitRows(),
      spend: [
        ...document.querySelectorAll(
          'ul[aria-label="This month by person"] li'
        ),
      ].map((row) =>
        [...row.querySelectorAll(":scope > span")]
          .map((part) => part.textContent?.trim())
          .filter((part) => part !== "")
          .join(" | ")
      ),
    }).toStrictEqual({
      buttons: [],
      rows: [
        "Everyone without an exception$10.00 a month, no limit on messages",
      ],
      spend: [
        "Ada LovelaceThe default: $10.00 a month, no limit on messages | $2.50 of $10.00",
        "Bea KosterNo limit set: No limit | $0.75",
      ],
    });
  });
});
