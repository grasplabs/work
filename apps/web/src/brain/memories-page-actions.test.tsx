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
        entity: globex,
        memories: [memory("m-g", "Globex", "Paying")],
        next: null,
      });
      replies.get("e-acme")?.release({
        entity: acme,
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

  it("names the open entity as the page reads it again", async () => {
    let lost = false;
    const own: BrainEntityListed = {
      entity: { store: "own", id: "e-own" },
      kind: "customer",
      name: "Acme",
      unreadable: false,
    };
    await shown({
      contested: async () => await Promise.resolve({ facts: [], next: null }),
      entities: async () =>
        await Promise.resolve({
          entities: [lost ? { ...own, name: null, unreadable: true } : own],
          next: null,
        }),
      memories: async () =>
        await Promise.resolve({
          entity: lost ? { ...own, name: null, unreadable: true } : own,
          memories: [
            memory("m-mine", "e-own", "Churned", {
              store: "own",
              statement: "Churned",
              source: null,
              yours: true,
            }),
          ],
          next: null,
        }),
      confirm: async () => {
        // Meanwhile, the shared entity it stands for went out of reach.
        lost = true;
        return await Promise.resolve("done");
      },
    });
    await press(buttons("Acme")[0]);
    await press(buttons("This one is right")[0]);
    expect(document.querySelector("h3")?.textContent).toBe(
      "Something you corrected, which you can no longer read"
    );
  });

  it("can't be closed while a correction saves", async () => {
    const reply = held<unknown>();
    await shown({
      contested: async () => await Promise.resolve(factPage()),
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      correct: async () => await reply.promise,
    });
    await press(buttons("It's wrong")[0]);
    await save("Paused");
    const closeOffered = [
      ...document.querySelectorAll("[role=dialog] button"),
    ].some((each) => each.textContent === "Close");
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await Promise.resolve();
    });
    await settle();
    const open = document.querySelector("textarea") !== null;
    await act(async () => {
      reply.release({ memory: "m-new", entity: "e-own" });
      await Promise.resolve();
    });
    await settle();
    expect({
      closeOffered,
      open,
      closedOnceSaved: document.querySelector("textarea") === null,
    }).toStrictEqual({
      closeOffered: false,
      open: true,
      closedOnceSaved: true,
    });
  });

  it("drops a Show more that fails after the list was read again", async () => {
    const more = held<unknown>();
    await shown({
      contested: async (next?: unknown) =>
        next === undefined || next === null
          ? await Promise.resolve({ ...factPage(), next: { store: "shared" } })
          : await more.promise,
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async () => await Promise.resolve("done"),
    });
    await press(buttons("Show more")[0]);
    await press(buttons("This one is right")[0]);
    await act(async () => {
      more.release(Promise.reject(new Error("The connection dropped")));
      await Promise.resolve();
    });
    await settle();
    expect({
      said: document.body.textContent.includes("The connection dropped"),
      offered: buttons("Show more")[0]?.disabled,
    }).toStrictEqual({ said: false, offered: false });
  });

  it("names a shared entity no longer readable while open as one there is nothing to read of", async () => {
    let lost = false;
    await shown({
      contested: async () =>
        await Promise.resolve(lost ? { facts: [], next: null } : factPage()),
      entities: async () =>
        await Promise.resolve({ entities: lost ? [] : [acme], next: null }),
      memories: async () =>
        await Promise.resolve(
          lost
            ? { entity: null, memories: [], next: null }
            : {
                entity: acme,
                memories: [memory("m-x", "Acme", "Renewing")],
                next: null,
              }
        ),
      confirm: async () => {
        lost = true;
        return await Promise.resolve("done");
      },
    });
    await press(
      [...document.querySelectorAll("section ul button")].find(
        (each): each is HTMLButtonElement =>
          each instanceof HTMLButtonElement && each.textContent === "Acme"
      )
    );
    const before = document.querySelector("h3")?.textContent;
    await press(buttons("This one is right")[0]);
    expect({
      before,
      after: document.querySelector("h3")?.textContent,
    }).toStrictEqual({ before: "Acme", after: "Nothing you can read" });
  });

  it("shows a correction's failure when its memory left the list while it saved", async () => {
    const confirmed = held<"done">();
    const saved = held<unknown>();
    let gone = false;
    await shown({
      contested: async () =>
        await Promise.resolve(gone ? { facts: [], next: null } : factPage()),
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async () => {
        const answer = await confirmed.promise;
        gone = true;
        return answer;
      },
      correct: async () => await saved.promise,
    });
    await press(buttons("This one is right")[0]);
    await press(buttons("It's wrong")[1]);
    await save("Paused");
    await act(async () => {
      confirmed.release("done");
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      saved.release(
        Promise.reject(
          Object.assign(new Error("The store failed"), {
            code: "brain.store_failed",
          })
        )
      );
      await Promise.resolve();
    });
    await settle();
    expect(document.body.textContent).toContain("The store failed");
  });

  it("offers no more of a list while it is read again, so no page lands after the wrong one", async () => {
    const fresh = held<unknown>();
    let reads = 0;
    await shown({
      contested: async (next?: unknown) => {
        if (next !== undefined && next !== null) {
          return await Promise.resolve({ facts: [], next: null });
        }
        reads += 1;
        return reads === 1
          ? await Promise.resolve({ ...factPage(), next: { store: "shared" } })
          : await fresh.promise;
      },
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async () => await Promise.resolve("done"),
    });
    await press(buttons("This one is right")[0]);
    const during = buttons("Show more")[0]?.disabled;
    await act(async () => {
      fresh.release({ ...factPage(), next: { store: "shared" } });
      await Promise.resolve();
    });
    await settle();
    expect({ during, after: buttons("Show more")[0]?.disabled }).toStrictEqual({
      during: true,
      after: false,
    });
  });

  it("sends one call for two clicks in one tick", async () => {
    let mores = 0;
    let confirms = 0;
    await shown({
      contested: async (next?: unknown) => {
        if (next !== undefined && next !== null) {
          mores += 1;
          return await Promise.resolve({ facts: [], next: null });
        }
        return await Promise.resolve({
          ...factPage(),
          next: { store: "shared" },
        });
      },
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async () => {
        confirms += 1;
        return await Promise.resolve("done");
      },
    });
    for (const label of ["Show more", "This one is right"]) {
      // oxlint-disable-next-line no-await-in-loop -- one control after another
      await act(async () => {
        const [button] = buttons(label);
        button?.click();
        button?.click();
        await Promise.resolve();
      });
      // oxlint-disable-next-line no-await-in-loop -- each settles in turn
      await settle();
    }
    expect({ mores, confirms }).toStrictEqual({ mores: 1, confirms: 1 });
  });

  it("clears a failed confirmation's message once the list is read again", async () => {
    let tries = 0;
    await shown({
      contested: async () => await Promise.resolve(factPage()),
      entities: async () => await Promise.resolve({ entities: [], next: null }),
      confirm: async () => {
        tries += 1;
        if (tries === 1) {
          throw Object.assign(new Error("The store failed"), {
            code: "brain.store_failed",
          });
        }
        return await Promise.resolve("done");
      },
    });
    await press(buttons("This one is right")[0]);
    const said = document.body.textContent.includes("The store failed");
    await press(buttons("This one is right")[1]);
    expect({
      said,
      after: document.body.textContent.includes("The store failed"),
    }).toStrictEqual({ said: true, after: false });
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
          entity: own,
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

/** Which of the page's paged lists a case pages. */
type Paged = "entities" | "memories" | "contested";

/** The version a further page's cursor was read at. */
const versionOf = (next: unknown): string => {
  const cursor =
    typeof next === "object" && next !== null && "after" in next
      ? next.after
      : next;
  const version =
    typeof cursor === "object" && cursor !== null && "v" in cursor
      ? cursor.v
      : undefined;
  return typeof version === "string" ? version : "";
};

/**
 * A faked core whose lists are read anew at each version: every row and
 * every cursor carries the version it was read at, and the list `paged`
 * has a second page. Each further page asked for records its cursor's
 * version; a confirmation moves the version on.
 */
const versioned = (paged: Paged) => {
  const cursors: string[] = [];
  const state = { version: 1, cursors };
  const nextOf = (list: Paged) =>
    list === paged ? { v: String(state.version) } : null;
  const fact = (name: string) => ({
    about: entity(`f-${name}`, name),
    attribute: "status" as const,
    sides: [
      memory(`m-${name}-a`, name, "Renewing", { contested: true }),
      memory(`m-${name}-b`, name, "Churned", { contested: true }),
    ],
    more: false,
  });
  const api = {
    contested: async (next?: unknown) => {
      if (next !== undefined && next !== null) {
        const v = versionOf(next);
        state.cursors.push(v);
        return await Promise.resolve({
          facts: [fact(`Fact v${v} p2`)],
          next: null,
        });
      }
      const after = nextOf("contested");
      return await Promise.resolve({
        facts: [fact(`Fact v${state.version} p1`)],
        next: after === null ? null : { store: "shared", after },
      });
    },
    entities: async (kind: string, next?: unknown) => {
      const label = kind === "customer" ? "Customer" : "Person";
      if (next !== undefined && next !== null) {
        const v = versionOf(next);
        state.cursors.push(v);
        return await Promise.resolve({
          entities: [entity(`e-${label}-v${v}-p2`, `${label} v${v} p2`)],
          next: null,
        });
      }
      const listed =
        paged === "memories"
          ? [entity("e-a", "Account A"), entity("e-b", "Account B")]
          : [
              entity(
                `e-${label}-v${state.version}-p1`,
                `${label} v${state.version} p1`
              ),
            ];
      const after = kind === "customer" ? nextOf("entities") : null;
      return await Promise.resolve({
        entities: listed,
        next: after === null ? null : { store: "shared", after },
      });
    },
    memories: async ({ id }: BrainEntityRef, next?: unknown) => {
      const name = id === "e-a" ? "Account A" : "Account B";
      if (next !== undefined && next !== null) {
        const v = versionOf(next);
        state.cursors.push(v);
        return await Promise.resolve({
          entity: entity(id, name),
          memories: [memory(`m-${id}-v${v}-p2`, `${name} v${v} p2`, "Paying")],
          next: null,
        });
      }
      return await Promise.resolve({
        entity: entity(id, name),
        memories: [
          memory(
            `m-${id}-v${state.version}-p1`,
            `${name} v${state.version} p1`,
            "Paying"
          ),
        ],
        next: nextOf("memories"),
      });
    },
    confirm: async () => {
      state.version += 1;
      return await Promise.resolve("done");
    },
  };
  return { state, api };
};

/** Picks `kind` in the kind select. */
const pickKind = async (kind: string): Promise<void> => {
  const select = document.querySelector("select");
  if (!select) {
    throw new TypeError("No kind select");
  }
  await act(async () => {
    select.value = kind;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
};

/** The list button named exactly `name`. */
const listed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("section ul button")].find(
    (each): each is HTMLButtonElement =>
      each instanceof HTMLButtonElement && each.textContent === name
  );

/**
 * Each paged list on the page, as a person uses it: load more, leave it
 * or change something while away, come back. `leave` and `back` act on
 * the page; `meanwhile` moves the faked core on (a change made elsewhere,
 * a memory retired) unless the page's own action did.
 */
const pagedLists: {
  name: string;
  paged: Paged;
  stale: string;
  fresh: [string, string];
  open?: () => Promise<void>;
  leave: () => Promise<void>;
  back: () => Promise<void>;
  meanwhile: boolean;
}[] = [
  {
    name: "the entities of a kind, after another kind was open",
    paged: "entities",
    stale: "Customer v1 p2",
    fresh: ["Customer v2 p1", "Customer v2 p2"],
    leave: async () => {
      await pickKind("person");
    },
    back: async () => {
      await pickKind("customer");
    },
    meanwhile: true,
  },
  {
    name: "the memories of an entity, after another entity was open",
    paged: "memories",
    stale: "Account A v1 p2",
    fresh: ["Account A v2 p1", "Account A v2 p2"],
    open: async () => {
      await press(listed("Account A"));
    },
    leave: async () => {
      await press(listed("Account B"));
    },
    back: async () => {
      await press(listed("Account A"));
    },
    meanwhile: true,
  },
  {
    name: "the facts sources disagree on, after a confirmation",
    paged: "contested",
    stale: "Fact v1 p2",
    fresh: ["Fact v2 p1", "Fact v2 p2"],
    leave: async () => {
      await press(buttons("This one is right")[0]);
    },
    back: async () => {
      await settle();
    },
    meanwhile: false,
  },
];

describe("the Memories page's paged lists, read again", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it.each(pagedLists)(
    "shows only a fresh read of $name, going on from the fresh read",
    async ({ paged, stale, fresh, open, leave, back, meanwhile }) => {
      const { state, api } = versioned(paged);
      await shown(api);
      await open?.();
      await press(buttons("Show more")[0]);
      const loaded = document.body.textContent.includes(stale);
      await leave();
      if (meanwhile) {
        state.version += 1;
      }
      await back();
      const returned = document.body.textContent;
      // More is offered from the fresh read: pressed when it is.
      const offered = buttons("Show more");
      for (const more of offered.slice(0, 1)) {
        // oxlint-disable-next-line no-await-in-loop -- at most one
        await press(more);
      }
      expect({
        loaded,
        offeredOnReturn: offered.length,
        staleOnReturn: returned.includes(stale),
        freshOnReturn: returned.includes(fresh[0]),
        goesOnFrom: state.cursors.at(-1),
        freshMore: document.body.textContent.includes(fresh[1]),
      }).toStrictEqual({
        loaded: true,
        offeredOnReturn: 1,
        staleOnReturn: false,
        freshOnReturn: true,
        goesOnFrom: "2",
        freshMore: true,
      });
    }
  );
});
