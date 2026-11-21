// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  answeredAdmin,
  FailedError,
  gridRow,
  openAdmin,
  sectionReads,
  settle,
  until,
} from "../../test/app.tsx";
import { emptyAdminSnapshot } from "../../test/snapshots.ts";
import type { AnsweredAdmin } from "./org-reads.ts";
import { freshMs } from "./org-reads.ts";

// What staff change on an organization's page shows changed once the
// change is through, within the minute its last answer stands: the page
// asks its core again for what it changed, never shows the answer from
// before (src/admin/org-loads.ts, `readOrganization`).

const acme = gridRow({ id: "acme", name: "Acme" });
const globex = gridRow({
  id: "globex",
  name: "Globex",
  hostname: "globex.grasp.test",
});

/** Acme's core answering `before` until `changed` says the change went through, then `after`. */
const answering = (before: AnsweredAdmin, after: AnsweredAdmin) => {
  let changed = false;
  return {
    change: () => {
      changed = true;
    },
    admin: () => (changed ? after : before),
  };
};

/** Submits `form` as pressing its button does. */
const submit = async (form: Element | null | undefined): Promise<void> => {
  if (form === null || form === undefined) {
    throw new Error("No such form");
  }
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await Promise.resolve();
  });
  await settle();
};

/** What was agreed, as Acme's page shows it. */
const agreedOn = (page: Element): string =>
  page.querySelector('section[aria-label="Agreed before the first interview"]')
    ?.textContent ?? "";

/** Runs `move` on the page, then lets it come to rest. */
const go = async (move: () => unknown): Promise<void> => {
  await act(async () => {
    await move();
  });
  await settle();
};

/** Acme's contract tab: where what was agreed shows. */
const acmeContract = "/organizations/acme/details?tab=contract";

/**
 * Acme and Globex, Acme's core answering nothing agreed until a command
 * says the change went through (`command` answers it, or fails), then
 * what was agreed; staff on Acme's contract tab, come there by `journey`.
 * What its page shows, and how often Acme's core was asked.
 */
const onAcme = async (
  journey: (
    router: Awaited<ReturnType<typeof openAdmin>>["router"]
  ) => Promise<void>,
  command: () => unknown = () => ({
    refused: null,
    issuedAt: new Date().toISOString(),
  }),
  {
    applies = true,
    held,
    framed,
  }: {
    /** Whether the command changes what Acme's core answers. */
    applies?: boolean;
    /** Acme's core's answer to its `call`th read, what it held then, held back `until`. */
    held?: { call: number; until: Promise<unknown> };
    /** The frame's `call`th read of every client, what they held then, held back `until`. */
    framed?: { call: number; until: Promise<unknown> };
  } = {}
) => {
  const empty = emptyAdminSnapshot("Acme");
  const core = answering(
    answeredAdmin({ client: acme, snapshot: empty }),
    answeredAdmin({
      client: acme,
      snapshot: {
        ...empty,
        agreements: {
          processing: true,
          assessment: true,
          council: "none",
          processingOn: "2026-09-02",
        },
      },
    })
  );
  let reads = 0;
  let frameReads = 0;
  let down = false;
  /** What Acme's core holds when asked, stamped as the Worker stamps it: when its answer came in. */
  const answerOnceIn = async (
    heldUntil: Promise<unknown> | undefined
  ): Promise<AnsweredAdmin> => {
    const answer = core.admin();
    await heldUntil;
    return { ...answer, at: new Date().toISOString() };
  };
  const page = await openAdmin(acmeContract, {
    fetchClientGrid: [acme, globex],
    fetchClientAdmin: async (data: unknown) => {
      if (
        typeof data === "object" &&
        data !== null &&
        Reflect.get(data, "clientId") === "globex"
      ) {
        return answeredAdmin({ client: globex });
      }
      reads += 1;
      if (down) {
        throw new FailedError();
      }
      return await answerOnceIn(reads === held?.call ? held.until : undefined);
    },
    // Every client but the one the page reads alone.
    fetchClientAdmins: async (data: unknown) => {
      frameReads += 1;
      const except: unknown =
        typeof data === "object" && data !== null
          ? Reflect.get(data, "except")
          : undefined;
      const others =
        Array.isArray(except) && except.includes("globex")
          ? [
              await answerOnceIn(
                frameReads === framed?.call ? framed.until : undefined
              ),
            ]
          : [];
      return others;
    },
    ...sectionReads,
    commandFn: async () => {
      const answer = await command();
      if (applies) {
        core.change();
      }
      return answer;
    },
  });
  await journey(page.router);
  const asked = () =>
    page.calls.filter(
      ({ fn, data }) =>
        fn === "fetchClientAdmin" &&
        typeof data === "object" &&
        data !== null &&
        Reflect.get(data, "clientId") === "acme"
    ).length;
  return {
    ...page,
    core,
    asked,
    /** Acme's core stops answering. */
    fail: () => {
      down = true;
    },
  };
};

/** The dialog's form for what was agreed, in the document beside the page, once open. */
const agreementsForm = (): HTMLFormElement | undefined =>
  [...document.querySelectorAll("form")].find((form) =>
    form.textContent?.includes("Works council")
  );

/** Gives what was agreed on the page, as staff do in its dialog. */
const agree = async (page: Element): Promise<void> => {
  const open = [...page.querySelectorAll("button")].find(
    (button) => button.textContent === "Change what was agreed"
  );
  await go(() => {
    open?.click();
  });
  await submit(agreementsForm());
};

/** Ways staff come to Acme's contract tab, within the minute its answer stands. */
const journeys: [
  string,
  (router: Awaited<ReturnType<typeof openAdmin>>["router"]) => Promise<void>,
][] = [
  ["opened on it", async () => {}],
  [
    "after pointing at another organization",
    async (router) => {
      await go(async () => {
        await router.preloadRoute({
          to: "/organizations/$clientId",
          params: { clientId: "globex" },
        });
      });
    },
  ],
  [
    "back from another organization by a link",
    async (router) => {
      await go(() => {
        router.history.push("/organizations/globex");
      });
      await go(() => {
        router.history.push(acmeContract);
      });
    },
  ],
  [
    "back from another organization by the browser's back",
    async (router) => {
      await go(() => {
        router.history.push("/organizations/globex");
      });
      await go(() => {
        router.history.back();
      });
    },
  ],
  [
    "back by the browser's forward",
    async (router) => {
      await go(() => {
        router.history.push("/organizations/globex");
      });
      await go(() => {
        router.history.back();
      });
      await go(() => {
        router.history.forward();
      });
      await go(() => {
        router.history.back();
      });
    },
  ],
];

describe("a change on an organization's page", () => {
  it.each(journeys)(
    "shows what was agreed once a command gives it, though the page's answer was a moment old: %s",
    async (_, journey) => {
      const { container, router, asked } = await onAcme(journey);
      const before = agreedOn(container);
      const askedBefore = asked();
      await agree(container);

      expect({
        on: router.state.location.pathname,
        before: before.includes("Not recorded yet"),
        after: agreedOn(container).includes("In place since 2 Sep 2026"),
        askedAgain: asked() - askedBefore,
      }).toStrictEqual({
        on: "/organizations/acme/details",
        before: true,
        after: true,
        askedAgain: 1,
      });
    }
  );

  it.each(journeys)(
    "shows what its core answers now on Read again, though its answer was a moment old: %s",
    async (_, journey) => {
      const { container, core, asked } = await onAcme(journey);
      const before = agreedOn(container);
      const askedBefore = asked();
      // Changed elsewhere: by another staff member, or on the company's own Grasp.
      core.change();
      const again = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Read again"
      );
      await go(() => {
        again?.click();
      });

      expect({
        before: before.includes("Not recorded yet"),
        after: agreedOn(container).includes("In place since 2 Sep 2026"),
        askedAgain: asked() - askedBefore,
      }).toStrictEqual({ before: true, after: true, askedAgain: 1 });
    }
  );

  it("asks its core again when a command fails, as it may have applied, and shows what it answers", async () => {
    const { container, asked } = await onAcme(
      async () => {},
      () => {
        throw new FailedError();
      },
      // Failed before it applied: what its core answers stays as it was.
      { applies: false }
    );
    const askedBefore = asked();
    await agree(container);

    expect({
      shows: agreedOn(container).includes("Not recorded yet"),
      // Said in the dialog it was given from.
      failed:
        agreementsForm()?.textContent?.includes("That didn't work.") ?? false,
      askedAgain: asked() - askedBefore,
    }).toStrictEqual({ shows: true, failed: true, askedAgain: 1 });
  });

  it("shows what a command gives, though a slower Read again begun before it was still under way", async () => {
    const slow = Promise.withResolvers<null>();
    // Its second read (Read again's) answers only once let, with what it held before.
    const { container, router, asked, fail } = await onAcme(
      async () => {},
      undefined,
      { held: { call: 2, until: slow.promise } }
    );
    const again = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Read again"
    );
    await act(async () => {
      again?.click();
      await Promise.resolve();
    });
    await until(() => asked() === 2);
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change what was agreed"
    );
    await act(async () => {
      open?.click();
      await Promise.resolve();
    });
    await until(() => agreementsForm() !== undefined);
    await act(async () => {
      agreementsForm()?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
    // The page asks its core again for the change, never waiting on the older read.
    await until(() => asked() === 3);
    // The older read answers last, so its answer is stamped last.
    slow.resolve(null);
    await settle();
    const after = agreedOn(container);
    // Back to it from another organization within the minute: the answer kept.
    await go(() => {
      router.history.push("/organizations/globex");
    });
    await go(() => {
      router.history.back();
    });
    const cameBack = agreedOn(container);
    // Its core stops answering; Read again shows the last answer, marked.
    fail();
    const again2 = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Read again"
    );
    await go(() => {
      again2?.click();
    });

    expect({
      after: after.includes("In place since 2 Sep 2026"),
      cameBack: cameBack.includes("In place since 2 Sep 2026"),
      failedAgain: agreedOn(container).includes("In place since 2 Sep 2026"),
      marked: (container.querySelector("main")?.textContent ?? "").includes(
        "couldn’t be read again"
      ),
      asked: asked(),
    }).toStrictEqual({
      after: true,
      cameBack: true,
      failedAgain: true,
      marked: true,
      asked: 4,
    });
  });

  it("shows a change that came through after staff left its page, on coming back while the frame still reads it", async () => {
    const through = Promise.withResolvers<null>();
    const frame = Promise.withResolvers<null>();
    const { container, router, asked, calls } = await onAcme(
      async () => {},
      async () => {
        await through.promise;
        return { refused: null, issuedAt: new Date().toISOString() };
      },
      // The frame's read after the change (its second) is slow.
      { framed: { call: 2, until: frame.promise } }
    );
    const askedBefore = asked();
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change what was agreed"
    );
    await go(() => {
      open?.click();
    });
    await act(async () => {
      agreementsForm()?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
    // Staff go to another organization before the change is through.
    await act(async () => {
      router.history.push("/organizations/globex");
      await Promise.resolve();
    });
    await until(
      () => router.state.resolvedLocation?.pathname === "/organizations/globex"
    );
    through.resolve(null);
    // Through, the change reads the frame again, every client's core.
    await until(
      () => calls.filter(({ fn }) => fn === "fetchClientAdmins").length === 2
    );
    await act(async () => {
      router.history.push(acmeContract);
      await Promise.resolve();
    });
    frame.resolve(null);
    await settle();

    expect({
      on: router.state.location.pathname,
      agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
      // The page took the frame's read: its core asked no second time.
      askedAgain: asked() - askedBefore,
    }).toStrictEqual({
      on: "/organizations/acme/details",
      agreed: true,
      askedAgain: 0,
    });
  });

  it("shows both of two changes given at once from two parts of the page", async () => {
    const customerId = "cus_Acme1";
    const empty = emptyAdminSnapshot("Acme");
    let agreed = false;
    let linked = false;
    const { container, calls } = await openAdmin(acmeContract, {
      fetchClientGrid: [acme],
      fetchClientAdmin: () =>
        answeredAdmin({
          client: acme,
          snapshot: agreed
            ? {
                ...empty,
                agreements: {
                  processing: true,
                  assessment: true,
                  council: "none",
                  processingOn: "2026-09-02",
                },
              }
            : empty,
          billing: linked
            ? {
                state: "read",
                customerId,
                account: {
                  name: "Acme B.V.",
                  url: `https://dashboard.stripe.com/test/customers/${customerId}`,
                  pays: { by: "charge" },
                  subscription: null,
                  open: { count: 0, amount: [] },
                  overdue: { count: 0, amount: [], since: null },
                  lastPaid: null,
                  invoices: [],
                },
              }
            : { state: "not_linked" },
        }),
      fetchClientAdmins: [],
      ...sectionReads,
      commandFn: () => {
        agreed = true;
        return { refused: null, issuedAt: new Date().toISOString() };
      },
      setStripeCustomerFn: () => {
        linked = true;
        return { changed: true, refused: null };
      },
    });
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change what was agreed"
    );
    await go(() => {
      open?.click();
    });
    const field = container.querySelector<HTMLInputElement>(
      'input[name="customerId"]'
    );
    if (field !== null) {
      field.value = customerId;
    }
    const forms = [agreementsForm(), field?.closest("form")];
    // Both given in the same moment: the second's load supersedes the first's.
    await go(() => {
      for (const form of forms) {
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
      }
    });

    expect({
      forms: forms.every((form) => form !== null && form !== undefined),
      agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
      linked:
        container
          .querySelector("#contract-billing")
          ?.textContent?.includes("Everything billed is paid.") ?? false,
      asked: calls.filter(({ fn }) => fn === "fetchClientAdmin").length,
    }).toStrictEqual({ forms: true, agreed: true, linked: true, asked: 3 });
  });

  it("pointing at its own page while it shows asks its core nothing", async () => {
    const { router, asked } = await onAcme(async () => {});
    const askedBefore = asked();
    await go(async () => {
      await router.preloadRoute({
        to: "/organizations/$clientId",
        params: { clientId: "acme" },
      });
    });

    expect(asked() - askedBefore).toBe(0);
  });

  it("moving between its sections within the minute asks its core nothing", async () => {
    const { router, asked } = await onAcme(async () => {});
    const askedBefore = asked();
    await go(() => {
      router.history.push("/organizations/acme/details?tab=members");
    });
    await go(() => {
      router.history.push("/organizations/acme");
    });
    await go(() => {
      router.history.push(acmeContract);
    });

    expect(asked() - askedBefore).toBe(0);
  });

  it("moving between its sections once its answer is a minute old asks its core nothing: the router reloads a page it stays on only when asked, and the page says when it read it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { router, asked } = await onAcme(async () => {});
      const askedBefore = asked();
      vi.setSystemTime(Date.now() + freshMs + 1000);
      await go(() => {
        router.history.push("/organizations/acme/details?tab=members");
      });
      await go(() => {
        router.history.push("/organizations/acme");
      });
      await go(() => {
        router.history.push(acmeContract);
      });

      expect(asked() - askedBefore).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an organization deleted while its page is open", () => {
  it("keeps nothing of what its core answered, should one be added again under its id", async () => {
    let listed = true;
    let answers = true;
    const { router, main, container } = await openAdmin(acmeContract, {
      fetchClientGrid: () => (listed ? [acme] : []),
      fetchClientAdmin: () =>
        answers
          ? answeredAdmin({ client: acme })
          : {
              client: acme,
              state: "unreachable",
              lastAnsweredAt: null,
              error: "timeout",
            },
      fetchClientAdmins: [],
      ...sectionReads,
    });
    const before = agreedOn(container);
    // Deleted: the page, read again, finds it no longer there.
    listed = false;
    await go(async () => {
      await router.invalidate();
    });
    const gone = main();
    // Added again under the same id, its core not answering yet.
    listed = true;
    answers = false;
    await go(async () => {
      await router.invalidate();
    });

    expect({
      before: before.includes("Not recorded yet"),
      gone: gone.includes("This page is not here"),
      again: main().includes("’s Grasp didn’t answer"),
    }).toStrictEqual({ before: true, gone: true, again: true });
  });
});

describe("linking an organization to its Stripe customer", () => {
  it("shows a linked company's billing once it is linked to its Stripe customer, though the page's answer was a moment old", async () => {
    const customerId = "cus_Acme1";
    const core = answering(
      answeredAdmin({ client: acme }),
      answeredAdmin({
        client: acme,
        billing: {
          state: "read",
          customerId,
          account: {
            name: "Acme B.V.",
            url: `https://dashboard.stripe.com/test/customers/${customerId}`,
            pays: { by: "charge" },
            subscription: null,
            open: { count: 0, amount: [] },
            overdue: { count: 0, amount: [], since: null },
            lastPaid: null,
            invoices: [],
          },
        },
      })
    );
    const { container } = await openAdmin(
      "/organizations/acme/details?tab=contract",
      {
        fetchClientGrid: [acme],
        fetchClientAdmin: core.admin,
        fetchClientAdmins: [],
        setStripeCustomerFn: () => {
          core.change();
          return { changed: true, refused: null };
        },
      }
    );
    const billing = () =>
      container.querySelector("#contract-billing")?.textContent ?? "";
    const before = billing();

    const field = container.querySelector<HTMLInputElement>(
      'input[name="customerId"]'
    );
    if (field !== null) {
      field.value = customerId;
    }
    await submit(field?.closest("form"));

    expect({
      before: before.includes("Not linked to its customer in Stripe yet."),
      after: billing().includes("Everything billed is paid."),
    }).toStrictEqual({ before: true, after: true });
  });
});
