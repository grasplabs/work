// @vitest-environment happy-dom
import type {
  ListedSkill,
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

const asked = "---\nname: close-the-month\ndescription: Close it\n---\nSteps.";

const request: SkillShareRequest = {
  id: "share-1",
  name: "close-the-month",
  status: "pending",
  requestedAt: "2026-11-12T09:00:00.000Z",
  requestedBy: { userId: "u-2", name: "Anna" },
  decidedAt: null,
  version: null,
  text: asked,
  replaces: "grasp",
};

const shareOf = (name: string): SkillShare => ({
  id: `share-of-${name}`,
  name,
  status: "pending",
  requestedAt: "2026-11-12T09:00:00.000Z",
  requestedBy: { userId: "u-1", name: "Me" },
  decidedAt: null,
  version: null,
});

/** Shows the page on a faked core, as an admin or not, refusing saves with `refusal`. */
const shown = async ({
  admin,
  refusal,
  existing = [],
}: {
  admin: boolean;
  refusal?: string;
  /** The person's shares already there. */
  existing?: SkillShare[];
}) => {
  const calls: string[] = [];
  const shares: SkillShare[] = [...existing];
  let requests = [request];
  const skills = {
    overview: async (): Promise<SkillsOverview> => {
      await Promise.resolve();
      calls.push("overview");
      return {
        own: [own],
        company: [{ name: "file-expenses", version: 1, description: "File" }],
        shares: [...shares],
        requests: admin ? requests : null,
      };
    },
    save: async (text: string) => {
      await Promise.resolve();
      calls.push(`save ${text.split("\n")[1]}`);
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
      requests = [];
      return { ...request, status: "approved" as const, version: 1 };
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
      version: number | null
    ) => ({
      ...shareOf(name),
      id: `share-${name}`,
      status,
      version,
    });
    await shown({
      admin: false,
      existing: [
        at("waiting", "pending", null),
        at("added", "approved", 3),
        at("stuck", "approved", null),
        at("refused", "declined", null),
      ],
    });

    expect({
      waiting: stateOf("waiting"),
      added: stateOf("added"),
      stuck: stateOf("stuck"),
      refused: stateOf("refused"),
    }).toStrictEqual({
      waiting: "Waiting for an admin",
      added: "Added to the company's skills.",
      stuck: "Approved, but not added to the company's skills yet.",
      refused: "Declined",
    });
  });
});
