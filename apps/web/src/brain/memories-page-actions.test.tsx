// @vitest-environment happy-dom
import type {
  BrainContestedPage,
  BrainEntityListed,
  BrainEntityRef,
  BrainMemoryPlace,
  BrainMemoryShown,
} from "@grasp-os/shared/brain-memories";
import { Toaster } from "@grasp-os/ui/components/toast";
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

import { MemoriesPage } from "./memories-page.tsx";

// What the Memories page does with what its actions answer, against core's
// `brainMemories` faked, answers held back where order matters: a failed
// confirmation keeps its button; one that finds nothing to confirm, and a
// correction that finds nothing to correct, say so and read the page
// again; two confirmations at once both show; a reply for an entity no
// longer open, or for a list read again since, is dropped; the box is
// locked while a correction saves; focus stays where the person was; a
// page of no facts that has more still offers them; and the person's own
// word not yet confirmed can be confirmed.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const entity = (id: string, name: string): BrainEntityListed => ({
  entity: { store: "shared", id },
  kind: "customer",
  name,
  unreadable: false,
});
const acme = entity("e-acme", "Acme");
const globex = entity("e-globex", "Globex");

/** A memory about `about`, as core shows it. */
const memory = (
  id: string,
  about: string,
  value: string,
  more: Partial<BrainMemoryShown> = {}
): BrainMemoryShown => ({
  store: "shared",
  id,
  about,
  attribute: "status",
  object: null,
  value,
  type: "fact",
  statement: `${about} is ${value}`,
  quote: value,
  source: { source: { producer: "upload", id: `u-${id}` }, version: 1 },
  yours: false,
  learnedAt: "2026-11-10T09:00:00.000Z",
  endedAt: null,
  confirmed: null,
  contested: false,
  ...more,
});

/** Acme's two sides of its status, the ones in `confirmed` confirmed by the person. */
const sides = (confirmed: ReadonlySet<string> = new Set()) =>
  [
    memory("m-a", "Acme", "Renewing", { contested: true }),
    memory("m-b", "Acme", "Churned", { contested: true }),
  ].map((side) =>
    confirmed.has(side.id)
      ? { ...side, confirmed: { at: "2026-11-11T09:00:00.000Z", byYou: true } }
      : side
  );

/** A contested page of Acme's status, its sides as `sides` gives them. */
const factPage = (
  confirmed: ReadonlySet<string> = new Set()
): BrainContestedPage => ({
  facts: [
    { about: acme, attribute: "status", sides: sides(confirmed), more: false },
  ],
  next: null,
});

/** An answer held back until the test lets it go. */
interface Held<T> {
  promise: Promise<T>;
  release: (value: T) => void;
}

const held = <T,>(): Held<T> => {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, release: resolve };
};

/** Lets every pending read settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** Shows the page on a faked core answering with `api`. */
const shown = async (api: Readonly<Record<string, unknown>>) => {
  const core = {
    withSession: async <T,>(
      action: (session: { brainMemories: typeof api }) => Promise<T>
    ): Promise<T> => await action({ brainMemories: api }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: MemoriesPage,
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
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </I18nProvider>
    );
    await router.load();
  });
  await settle();
};

/** The buttons whose text starts with `label`. */
const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter((each) =>
    each.textContent.startsWith(label)
  );

/** Presses `button`. */
const press = async (button: HTMLButtonElement | undefined): Promise<void> => {
  if (!button) {
    throw new TypeError("No such button");
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** Types `text` into the correction box and saves it. */
const save = async (text: string): Promise<void> => {
  const box = document.querySelector("textarea");
  const form = box?.closest("form");
  if (!box || !form) {
    throw new TypeError("No correction box");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  await settle();
};

const changedText =
  "This memory has changed or is no longer yours to read. Look at it again first.";

describe("the Memories page's actions", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("keeps a failed confirmation's button, with why, and reads nothing again", async () => {
    const calls: string[] = [];
    await shown({
      contested: async () => {
        calls.push("contested");
        return await Promise.resolve(factPage());
      },
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async () => {
        calls.push("confirm");
        await Promise.resolve();
        throw new Error("The connection dropped");
      },
    });
    await press(buttons("This one is right")[0]);
    expect({
      said: document.body.textContent.includes("The connection dropped"),
      calls,
      disabled: buttons("This one is right")[0]?.disabled,
    }).toStrictEqual({
      said: true,
      calls: ["contested", "confirm"],
      disabled: false,
    });
  });

  it("says so and reads the page again when there is nothing to confirm", async () => {
    const calls: string[] = [];
    let gone = false;
    await shown({
      contested: async () => {
        calls.push("contested");
        return await Promise.resolve(
          gone ? { facts: [], next: null } : factPage()
        );
      },
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async () => {
        calls.push("confirm");
        gone = true;
        return await Promise.resolve("nothing");
      },
    });
    await press(buttons("This one is right")[0]);
    expect({
      said: document.body.textContent.includes(changedText),
      calls,
      offered: buttons("This one is right").length,
    }).toStrictEqual({
      said: true,
      calls: ["contested", "confirm", "contested"],
      offered: 0,
    });
  });

  it("shows both of two confirmations made at once", async () => {
    const replies: Held<"done">[] = [];
    const confirmed = new Set<string>();
    await shown({
      contested: async () => await Promise.resolve(factPage(confirmed)),
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async ({ memory: id }: BrainMemoryPlace) => {
        const reply = held<"done">();
        replies.push(reply);
        const answer = await reply.promise;
        confirmed.add(id);
        return answer;
      },
    });
    const [first, second] = buttons("This one is right");
    await press(first);
    await press(second);
    for (const reply of replies) {
      // oxlint-disable-next-line no-await-in-loop -- one answer after another
      await act(async () => {
        reply.release("done");
        await Promise.resolve();
      });
      // oxlint-disable-next-line no-await-in-loop -- each settles in turn
      await settle();
    }
    expect({
      shown: document.body.textContent.split("Confirmed by you").length - 1,
      offered: buttons("This one is right").length,
    }).toStrictEqual({ shown: 2, offered: 0 });
  });

  it("drops a reply for an entity no longer open", async () => {
    const replies = new Map<string, Held<unknown>>();
    await shown({
      contested: async () => await Promise.resolve({ facts: [], next: null }),
      entities: async () =>
        await Promise.resolve({ entities: [acme, globex], next: null }),
      memories: async ({ id }: BrainEntityRef) => {
        const reply = held<unknown>();
        replies.set(id, reply);
        return await reply.promise;
      },
    });
    await press(buttons("Acme")[0]);
    await press(buttons("Globex")[0]);
    await act(async () => {
      replies.get("e-globex")?.release({
        memories: [memory("m-g", "Globex", "Paying")],
        next: null,
      });
      replies.get("e-acme")?.release({
        memories: [memory("m-x", "Acme", "Renewing")],
        next: null,
      });
      await Promise.resolve();
    });
    await settle();
    const text = document.body.textContent;
    expect({
      globex: text.includes("Globex is Paying"),
      acme: text.includes("Acme is Renewing"),
    }).toStrictEqual({ globex: true, acme: false });
  });

  it("locks the box while a correction saves, and gives focus back to what opened it", async () => {
    const reply = held<unknown>();
    await shown({
      contested: async () => await Promise.resolve(factPage()),
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      correct: async () => await reply.promise,
    });
    await press(buttons("It's wrong")[0]);
    await save("Paused");
    const locked = document.querySelector("textarea")?.disabled;
    await act(async () => {
      reply.release({ memory: "m-new", entity: "e-own" });
      await Promise.resolve();
    });
    await settle();
    await settle();
    expect({
      locked,
      focused: document.activeElement === buttons("It's wrong")[0],
    }).toStrictEqual({ locked: true, focused: true });
  });

  it("says so, closes and reads the page again when a correction finds nothing to correct", async () => {
    const calls: string[] = [];
    await shown({
      contested: async () => {
        calls.push("contested");
        return await Promise.resolve(factPage());
      },
      entities: async () => {
        calls.push("entities");
        return await Promise.resolve({ entities: [], next: null });
      },
      correct: async () => {
        calls.push("correct");
        return await Promise.resolve(null);
      },
    });
    await press(buttons("It's wrong")[0]);
    await save("Paused");
    expect({
      said: document.body.textContent.includes(changedText),
      open: document.querySelector("textarea") !== null,
      calls: calls.toSorted(),
    }).toStrictEqual({
      said: true,
      open: false,
      calls: ["contested", "contested", "correct", "entities", "entities"],
    });
  });

  it("keeps focus on the memory once its confirmation lands", async () => {
    const confirmed = new Set<string>();
    await shown({
      contested: async () => await Promise.resolve(factPage(confirmed)),
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async ({ memory: id }: BrainMemoryPlace) => {
        confirmed.add(id);
        return await Promise.resolve("done");
      },
    });
    await press(buttons("This one is right")[0]);
    expect(document.activeElement?.textContent).toBe(
      "Status: RenewingAcme is Renewing"
    );
  });

  it("offers more of a page that holds no fact but has more after it", async () => {
    await shown({
      contested: async () =>
        await Promise.resolve({ facts: [], next: { store: "shared" } }),
      entities: async () => await Promise.resolve({ entities: [], next: null }),
    });
    expect({
      nothing: document.body.textContent.includes(
        "Nothing you may read is disputed"
      ),
      more: buttons("Show more").length,
    }).toStrictEqual({ nothing: false, more: 1 });
  });

  it("offers to confirm the person's own word not yet confirmed", async () => {
    const own: BrainEntityListed = {
      entity: { store: "own", id: "e-own" },
      kind: "customer",
      name: null,
      unreadable: true,
    };
    const confirmedOwn: string[] = [];
    await shown({
      contested: async () => await Promise.resolve({ facts: [], next: null }),
      entities: async () =>
        await Promise.resolve({ entities: [own], next: null }),
      memories: async () =>
        await Promise.resolve({
          memories: [
            memory("m-mine", "e-own", "Churned", {
              store: "own",
              statement: "Churned",
              source: null,
              yours: true,
              confirmed:
                confirmedOwn.length > 0
                  ? { at: "2026-11-11T09:00:00.000Z", byYou: true }
                  : null,
            }),
          ],
          next: null,
        }),
      confirm: async (place: BrainMemoryPlace) => {
        confirmedOwn.push(`${place.store} ${place.memory}`);
        return await Promise.resolve("done");
      },
    });
    await press(
      buttons("Something you corrected, which you can no longer read")[0]
    );
    await press(buttons("This one is right")[0]);
    expect({
      confirmedOwn,
      shown: document.body.textContent.includes("Confirmed by you"),
      // Its words once: they are its value and its statement alike.
      once: document.body.textContent.split("Churned").length - 1,
    }).toStrictEqual({
      confirmedOwn: ["own m-mine"],
      shown: true,
      once: 1,
    });
  });
});
