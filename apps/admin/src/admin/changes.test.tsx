// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";

import {
  act,
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
  }: {
    /** Whether the command changes what Acme's core answers. */
    applies?: boolean | { onCommand: number };
    /** Acme's core's answer to its `call`th read, what it held then, held back `until`. */
    held?: { call: number; until: Promise<unknown> };
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
  let commands = 0;
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
    // The frame's counts: nothing needs Grasp anywhere.
    fetchClientSummaries: [],
    ...sectionReads,
    commandFn: async () => {
      commands += 1;
      const given = commands;
      const answer = await command();
      if (
        applies === true ||
        (typeof applies === "object" && applies.onCommand === given)
      ) {
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

/** Lets what is under way come in: answers, and what the page does with them. */
const aMoment = async (): Promise<void> => {
  await act(async () => {
    // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form here
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  });
};

/** Opens the dialog and submits what was agreed, without waiting for it to go through. */
const giveAgreements = async (page: Element): Promise<void> => {
  const open = [...page.querySelectorAll("button")].find(
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
};

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

  it("shows a change that came through after staff left its page, on coming back", async () => {
    const through = Promise.withResolvers<null>();
    const { container, router, asked, calls } = await onAcme(
      async () => {},
      async () => {
        await through.promise;
        return { refused: null, issuedAt: new Date().toISOString() };
      }
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
    // Through, the change reads the frame again.
    await until(
      () => calls.filter(({ fn }) => fn === "fetchClientSummaries").length === 2
    );
    await go(() => {
      router.history.push(acmeContract);
    });

    expect({
      on: router.state.location.pathname,
      agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
      // Its answer predates the change: its core is asked alone, once.
      askedAgain: asked() - askedBefore,
    }).toStrictEqual({
      on: "/organizations/acme/details",
      agreed: true,
      askedAgain: 1,
    });
  });

  it.each([
    ["Read again there", "read again"],
    ["its Setup reloading itself, as it does while it provisions", "setup"],
  ] as const)(
    "shows a change that came through after staff left its page, though the page they went to reloaded meanwhile: %s",
    async (_, second) => {
      const through = Promise.withResolvers<null>();
      const { container, router, calls } = await onAcme(
        async () => {},
        async () => {
          await through.promise;
          return { refused: null, issuedAt: new Date().toISOString() };
        }
      );
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
      await act(async () => {
        router.history.push("/organizations/globex");
        await Promise.resolve();
      });
      await until(
        () =>
          router.state.resolvedLocation?.pathname === "/organizations/globex" &&
          [...container.querySelectorAll("button")].some(
            (button) => button.textContent === "Read again"
          )
      );
      through.resolve(null);
      await until(
        () =>
          calls.filter(({ fn }) => fn === "fetchClientSummaries").length === 2
      );
      // On the other organization's page, a second reload.
      await act(async () => {
        if (second === "read again") {
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent === "Read again")
            ?.click();
        } else {
          void router.invalidate({
            filter: (match) =>
              match.routeId === "/organizations/$clientId/setup",
          });
        }
        await Promise.resolve();
      });
      await go(() => {
        router.history.push(acmeContract);
      });

      expect({
        on: router.state.location.pathname,
        agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
      }).toStrictEqual({ on: "/organizations/acme/details", agreed: true });
    }
  );

  it.each([
    ["its core answers", true],
    ["its core doesn't answer", false],
  ] as const)(
    "never shows an answer from before a change as current, nothing left to wait on: %s",
    async (_, answers) => {
      const through = Promise.withResolvers<null>();
      const { container, router, calls, asked, fail } = await onAcme(
        async () => {},
        async () => {
          await through.promise;
          return { refused: null, issuedAt: new Date().toISOString() };
        }
      );
      const askedBefore = asked();
      await giveAgreements(container);
      await act(async () => {
        router.history.push("/organizations/globex");
        await Promise.resolve();
      });
      await until(
        () =>
          router.state.resolvedLocation?.pathname === "/organizations/globex"
      );
      through.resolve(null);
      await until(
        () =>
          calls.filter(({ fn }) => fn === "fetchClientSummaries").length === 2
      );
      await settle();
      if (!answers) {
        fail();
      }
      await go(() => {
        router.history.push(acmeContract);
      });
      const main = container.querySelector("main")?.textContent ?? "";

      expect({
        agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
        marked: main.includes("couldn’t be read again"),
        askedAgain: asked() - askedBefore,
      }).toStrictEqual({
        // Read alone once: the change, or, not answering, the last answer marked.
        agreed: answers,
        marked: !answers,
        askedAgain: 1,
      });
    }
  );

  it(
    "never shows an answer from before the latest change as current: two changes in a row, a read of Acme asked between them still under way",
    // Room for a page that never asks again to fail on what it shows, not on time.
    { timeout: 15_000 },
    async () => {
      const between = Promise.withResolvers<null>();
      const { container, router, asked } = await onAcme(
        async () => {},
        undefined,
        {
          // Only the second command changes what Acme's core answers.
          applies: { onCommand: 2 },
          // Acme's second read, asked between the changes, is slow.
          held: { call: 2, until: between.promise },
        }
      );
      const globexContract = "/organizations/globex/details?tab=contract";
      await go(() => {
        router.history.push(globexContract);
      });
      // The first change, on Globex.
      await agree(container);
      // To Acme: its answer predates the change, so its core is asked alone.
      await act(async () => {
        router.history.push(acmeContract);
        await Promise.resolve();
      });
      await until(() => asked() === 2);
      // Back to Globex while that read runs: the second change.
      await act(async () => {
        router.history.push(globexContract);
        await Promise.resolve();
      });
      await until(
        () =>
          router.state.resolvedLocation?.pathname ===
            "/organizations/globex/details" && agreedOn(container) !== ""
      );
      await giveAgreements(container);
      await until(() => router.state.status === "idle");
      const askedBefore = asked();
      // To Acme while the read asked between the changes still runs.
      await act(async () => {
        router.history.push(acmeContract);
        await Promise.resolve();
      });
      await until(() => asked() > askedBefore).catch(() => null);
      between.resolve(null);
      await settle();

      expect({
        agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
        askedAgain: asked() - askedBefore,
      }).toStrictEqual({ agreed: true, askedAgain: 1 });
    }
  );

  it("never shows an answer from before a change as current when it came in after the change, nothing running", async () => {
    const slow = Promise.withResolvers<null>();
    const through = Promise.withResolvers<null>();
    const { container, router, calls, asked } = await onAcme(
      async () => {},
      async () => {
        await through.promise;
        return { refused: null, issuedAt: new Date().toISOString() };
      },
      // Read again's read (Acme's second) is slow.
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
    await giveAgreements(container);
    await act(async () => {
      router.history.push("/organizations/globex");
      await Promise.resolve();
    });
    await until(
      () => router.state.resolvedLocation?.pathname === "/organizations/globex"
    );
    through.resolve(null);
    await until(
      () => calls.filter(({ fn }) => fn === "fetchClientSummaries").length === 2
    );
    // Read again's read answers now, after the change, with what was before it.
    slow.resolve(null);
    await settle();
    const askedBefore = asked();
    await go(() => {
      router.history.push(acmeContract);
    });

    expect({
      agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
      askedAgain: asked() - askedBefore,
    }).toStrictEqual({ agreed: true, askedAgain: 1 });
  });

  it("a Setup reloading itself marks no change: coming to another organization after it shows its answer at once", async () => {
    const { router, calls } = await onAcme(async (to) => {
      await go(() => {
        to.history.push("/organizations/globex/details?tab=contract");
      });
    });
    // On Acme's Setup, as its polls and its own settings reload it.
    await go(() => {
      router.history.push("/organizations/acme/setup");
    });
    const onSetup = router.state.matches.some(
      (match) => match.routeId === "/organizations/$clientId/setup"
    );
    await go(async () => {
      await router.invalidate({
        filter: (match) => match.routeId === "/organizations/$clientId/setup",
      });
    });
    await go(() => {
      router.history.push("/organizations/globex/details?tab=contract");
    });

    expect({
      onSetup,
      globexAsked: calls.filter(
        ({ fn, data }) =>
          fn === "fetchClientAdmin" &&
          typeof data === "object" &&
          data !== null &&
          Reflect.get(data, "clientId") === "globex"
      ).length,
      // Read once on the way, within the minute: not again.
    }).toStrictEqual({ onSetup: true, globexAsked: 1 });
  });

  it("after its minute, moving to another organization reads the frame no second time: only a change, or reopening the same address, does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { router, calls } = await onAcme(async () => {});
    const framed = () =>
      calls.filter(({ fn }) => fn === "fetchClientSummaries").length;
    const before = framed();
    vi.setSystemTime(Date.now() + freshMs + 1000);
    await go(() => {
      router.history.push("/organizations/globex");
    });
    await go(() => {
      router.history.push(acmeContract);
    });

    expect(framed() - before).toBe(0);
  });

  it("reads the open organization's core once in a reload after a change, its answer coming after the grid's", async () => {
    const core = Promise.withResolvers<null>();
    const { container, calls, asked } = await onAcme(
      async () => {},
      undefined,
      // In the reload after the change: Acme's second read.
      { held: { call: 2, until: core.promise } }
    );
    const askedBefore = asked();
    await giveAgreements(container);
    await until(
      () => calls.filter(({ fn }) => fn === "fetchClientGrid").length === 2
    );
    await aMoment();
    core.resolve(null);
    await settle();

    expect({
      agreed: agreedOn(container).includes("In place since 2 Sep 2026"),
      // One read of its core in the reload, as its audit log records it.
      askedAgain: asked() - askedBefore,
    }).toStrictEqual({ agreed: true, askedAgain: 1 });
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
      // Once opened, and once in the reload that holds both.
    }).toStrictEqual({ forms: true, agreed: true, linked: true, asked: 2 });
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
