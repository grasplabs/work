// @vitest-environment happy-dom
import type {
  ListedSkill,
  OwnSkillShare,
  SkillShare,
  SkillShareRequest,
  SkillsOverview,
} from "@grasp-os/shared/skills";
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

import { SkillsPage } from "./skills-page.tsx";

// The skills page, against core's `skills` as the page reaches it over
// RPC, faked: the person's own skills, saved from the editor and shared;
// the company's; and, for an admin, a share waiting with the exact text
// approving it adds, approved from the page; a refusal is said.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every pending call settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 12; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

const own: ListedSkill = {
  name: "quote-a-tender",
  version: 2,
  description: "Quote a tender",
};

const other: ListedSkill = {
  name: "plan-a-trip",
  version: 1,
  description: "Plan a trip",
};

const asked = "---\nname: close-the-month\ndescription: Close it\n---\nSteps.";

const request: SkillShareRequest = {
  id: "share-1",
  name: "close-the-month",
  status: "pending",
  requestedAt: "2026-11-12T09:00:00.000Z",
  requestedBy: { userId: "u-2", name: "Anna" },
  decidedAt: null,
  version: null,
  open: true,
  text: asked,
  replaces: "grasp",
};

const shareOf = (name: string): OwnSkillShare => ({
  id: `share-of-${name}`,
  name,
  status: "pending",
  requestedAt: "2026-11-12T09:00:00.000Z",
  requestedBy: { userId: "u-1", name: "Me" },
  decidedAt: null,
  version: null,
  open: true,
  outdated: false,
});

/** Shows the page on a faked core, as an admin or not, refusing saves with `refusal`. */
const shown = async ({
  admin,
  refusal,
  existing = [],
  waiting = request,
  held = {},
  approveRefusal,
}: {
  admin: boolean;
  refusal?: string;
  /** The person's shares already there. */
  existing?: OwnSkillShare[];
  /** The share that waits for an admin. */
  waiting?: SkillShareRequest;
  /** Calls held until their promise settles: `save`, `read <name>`. */
  held?: Record<string, Promise<unknown>>;
  /** Refuses approving with this, after core moved the share on. */
  approveRefusal?: string;
}) => {
  const calls: string[] = [];
  const shares: OwnSkillShare[] = [...existing];
  let requests = [waiting];
  const skills = {
    overview: async (): Promise<SkillsOverview> => {
      await Promise.resolve();
      calls.push("overview");
      return {
        own: [own, other],
        company: [{ name: "file-expenses", version: 1, description: "File" }],
        shares: [...shares],
        requests: admin ? requests : null,
      };
    },
    save: async (text: string) => {
      await Promise.resolve();
      calls.push(`save ${text.split("\n")[1]}`);
      await held.save;
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
      return own;
    },
    share: async (name: string, version: number) => {
      await Promise.resolve();
      calls.push(`share ${name}@${version}`);
      const share = shareOf(name);
      shares.push(share);
      return share;
    },
    approve: async (id: string) => {
      await Promise.resolve();
      calls.push(`approve ${id}`);
      if (approveRefusal !== undefined) {
        // Decided, its add failed: approved, not added yet.
        requests = [{ ...waiting, status: "approved" }];
        throw new Error(approveRefusal);
      }
      requests = [];
      return { ...request, status: "approved" as const, version: 1 };
    },
    read: async (scope: string, name: string) => {
      await Promise.resolve();
      calls.push(`read ${scope} ${name}`);
      await held[`read ${name}`];
      return {
        name,
        version: 1,
        text: `---\nname: ${name}\ndescription: Read\n---\n`,
      };
    },
    decline: async (id: string) => {
      await Promise.resolve();
      calls.push(`decline ${id}`);
      requests = [];
      return { ...request, status: "declined" as const, open: false };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { skills: typeof skills }) => Promise<T>
    ): Promise<T> => await action({ skills }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: SkillsPage,
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
  return { calls };
};

/** The button whose text is `label`. */
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent === label
  );
  if (found === undefined) {
    throw new Error(`No button ${label}`);
  }
  return found;
};

const click = async (label: string): Promise<void> => {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
  await settle();
};

/** The badge on the person's share of `name`. */
const stateOf = (name: string): string | null | undefined =>
  [...document.querySelectorAll("li")]
    .find((item) => item.textContent?.startsWith(name))
    ?.querySelector('[data-slot="badge"]')?.textContent;

/** The page's skill editor. */
const editor = (): HTMLTextAreaElement => {
  const found = document.querySelector("textarea");
  if (found === null) {
    throw new Error("No editor");
  }
  return found;
};

describe("the skills page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("saves and shares the person's own skill, and shows what waits for an admin", async () => {
    const { calls } = await shown({ admin: false });
    await click("Save");
    await click("Share with the company");
    const text = document.body.textContent ?? "";
    expect({
      calls,
      ownListed: text.includes("quote-a-tender"),
      companyListed: text.includes("file-expenses"),
      waiting: button("Waiting for an admin").disabled,
      requests: text.includes("Shares waiting for you"),
      retire: [...document.querySelectorAll("button")].some(
        (each) => each.textContent === "Retire"
      ),
    }).toStrictEqual({
      calls: [
        "overview",
        "save name: my-skill",
        "overview",
        "share quote-a-tender@2",
        "overview",
      ],
      ownListed: true,
      companyListed: true,
      waiting: true,
      requests: false,
      retire: false,
    });
  });

  it("shows an admin each share's exact text, and approves it", async () => {
    const { calls } = await shown({ admin: true });
    const before = document.body.textContent ?? "";
    await click("Approve");
    expect({
      text: before.includes("Steps."),
      asker: before.includes("Anna"),
      replaces: before.includes(
        "Approving it replaces Grasp's own skill close-the-month for everyone."
      ),
      calls,
      after: document.body.textContent?.includes(
        "Nobody is waiting for you to decide a share."
      ),
    }).toStrictEqual({
      text: true,
      asker: true,
      replaces: true,
      calls: ["overview", "approve share-1", "overview"],
      after: true,
    });
  });

  it("says why core refused a save", async () => {
    await shown({ admin: false, refusal: "That isn't a task or a skill." });
    await click("Save");
    expect(document.body.textContent).toContain(
      "That isn't a task or a skill."
    );
  });

  it("tells the asker where each share stands, as its row says", async () => {
    const at = (
      name: string,
      status: SkillShare["status"],
      version: number | null,
      open: boolean
    ) => ({
      ...shareOf(name),
      id: `share-${name}`,
      status,
      version,
      open,
    });
    await shown({
      admin: false,
      existing: [
        at("waiting", "pending", null, true),
        at("added", "approved", 3, false),
        at("stuck", "approved", null, true),
        at("closed", "approved", null, false),
        at("refused", "declined", null, false),
        // Declined while its add was on its way, which then landed.
        at("landed", "declined", 2, false),
      ],
    });

    expect({
      waiting: stateOf("waiting"),
      added: stateOf("added"),
      stuck: stateOf("stuck"),
      closed: stateOf("closed"),
      refused: stateOf("refused"),
      landed: stateOf("landed"),
    }).toStrictEqual({
      waiting: "Waiting for an admin",
      added: "Added to the company's skills.",
      stuck: "Approved, but not added to the company's skills yet.",
      closed:
        "Closed before it was added: you asked again or deleted the skill.",
      refused: "Declined",
      landed: "Added to the company's skills.",
    });
  });

  it("lets an admin decline a share approved but not added yet", async () => {
    const { calls } = await shown({
      admin: true,
      waiting: {
        ...request,
        status: "approved",
        decidedAt: request.requestedAt,
      },
    });
    await click("Decline");

    expect({
      calls,
      after: document.body.textContent?.includes(
        "Nobody is waiting for you to decide a share."
      ),
    }).toStrictEqual({
      calls: ["overview", "decline share-1", "overview"],
      after: true,
    });
  });

  it("offers to share the saved version instead of a waiting share of an older one", async () => {
    const { calls } = await shown({
      admin: false,
      existing: [{ ...shareOf("quote-a-tender"), outdated: true }],
    });
    const instead = button("Share this version instead");
    const disabledBefore = instead.disabled;
    await click("Share this version instead");

    expect({ disabledBefore, calls }).toStrictEqual({
      disabledBefore: false,
      calls: ["overview", "share quote-a-tender@2", "overview"],
    });
  });

  it("reads the page again after an approval core refused, showing why and what it moved to", async () => {
    const { calls } = await shown({
      admin: true,
      approveRefusal: "Out of reach.",
    });
    await click("Approve");
    const text = document.body.textContent ?? "";

    expect({
      calls,
      said: text.includes("Out of reach."),
      retry: text.includes("Approved, not added yet: approve it again"),
    }).toStrictEqual({
      calls: ["overview", "approve share-1", "overview"],
      said: true,
      retry: true,
    });
  });

  it("keeps the editor still while it saves or reads, and applies only the read last asked for", async () => {
    const saving = Promise.withResolvers<boolean>();
    const firstRead = Promise.withResolvers<boolean>();
    await shown({
      admin: false,
      held: { save: saving.promise, "read quote-a-tender": firstRead.promise },
    });
    await click("Save");
    const whileSaving = editor().disabled;
    await act(async () => {
      saving.resolve(true);
      await Promise.resolve();
    });
    await settle();
    // Edit the first skill, whose read is slow, then the second.
    const edits = [...document.querySelectorAll("button")].filter(
      (each) => each.textContent === "Edit"
    );
    await act(async () => {
      edits[0]?.click();
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      edits[1]?.click();
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      firstRead.resolve(true);
      await Promise.resolve();
    });
    await settle();

    expect({
      whileSaving,
      shown: editor().value.includes("name: plan-a-trip"),
    }).toStrictEqual({ whileSaving: true, shown: true });
  });
});
