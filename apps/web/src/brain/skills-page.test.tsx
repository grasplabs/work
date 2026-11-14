// @vitest-environment happy-dom
import type {
  DecidedTeamSkill,
  ListedSkill,
  ListedTeamSkill,
  OwnSkillShare,
  SkillAudienceAsked,
  SkillProposal,
  SkillShare,
  SkillShareRequest,
  SkillsOverview,
  SkillTeam,
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
  audience: { kind: "company" },
  status: "pending",
  requestedAt: "2026-11-12T09:00:00.000Z",
  requestedBy: { userId: "u-2", name: "Anna" },
  decidedAt: null,
  version: null,
  superseded: false,
  text: asked,
  replaces: "grasp",
};

const proposalText =
  "---\nname: send-report\ndescription: Start the workflow send-report\n---\n\nWhen I ask for send report, start it.\n";

const proposal: SkillProposal = {
  name: "send-report",
  text: proposalText,
  basis: {
    workflow: { id: "wf-1", name: "send-report" },
    version: 3,
    runs: [1, 2, 3, 4, 5].map((day) => ({
      id: `run-${day}`,
      endedAt: `2026-11-0${day}T09:00:00.000Z`,
    })),
  },
};

/** The company, as a share is for it. */
const forCompany: OwnSkillShare["audience"] = { kind: "company" };

const shareOf = (
  name: string,
  audience: OwnSkillShare["audience"] = forCompany
): OwnSkillShare => ({
  id: `share-of-${name}`,
  name,
  audience,
  status: "pending",
  requestedAt: "2026-11-12T09:00:00.000Z",
  requestedBy: { userId: "u-1", name: "Me" },
  decidedAt: null,
  version: null,
  superseded: false,
  outdated: false,
  inUse: false,
});

/** Shows the page on a faked core, as an admin or not, refusing saves with `refusal`. */
const shown = async ({
  admin,
  refusal,
  existing = [],
  waiting = request,
  held = {},
  approveRefusal,
  company = ["file-expenses"],
  replacing = [],
  retiring = [],
  overviewRefusals = [],
  teams = [],
  team = [],
  teamSkills = [],
  proposals = [],
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
  /** The names of the company's live skills. */
  company?: string[];
  /** Of the company's skills, those with a newer approved version on its way. */
  replacing?: string[];
  /** Of the company's skills, those with a retirement on its way. */
  retiring?: string[];
  /** Which reads of the page core refuses, counting from 1. */
  overviewRefusals?: number[];
  /** The teams the person is in. */
  teams?: SkillTeam[];
  /** Their teams' skills. */
  team?: ListedTeamSkill[];
  /** Every team's skill in use, as an admin is shown them. */
  teamSkills?: DecidedTeamSkill[];
  /** The skills proposed to the person. */
  proposals?: SkillProposal[];
}) => {
  let proposed = [...proposals];
  const calls: string[] = [];
  const owned = [own, other];
  const onItsWayOf = (name: string) => {
    if (replacing.includes(name)) {
      return "version" as const;
    }
    return retiring.includes(name) ? ("retirement" as const) : null;
  };
  const shares: OwnSkillShare[] = [...existing];
  let requests = [waiting];
  const skills = {
    overview: async (): Promise<SkillsOverview> => {
      await Promise.resolve();
      calls.push("overview");
      if (
        overviewRefusals.includes(
          calls.filter((call) => call === "overview").length
        )
      ) {
        throw new Error("Out of reach.");
      }
      return {
        own: [...owned],
        company: company.map((name) => ({
          name,
          description: "File",
          version: 1,
          onItsWay: onItsWayOf(name),
        })),
        team,
        teams,
        shares: [...shares],
        proposals: [...proposed],
        requests: admin ? requests : null,
        teamSkills: admin ? teamSkills : null,
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
    share: async (
      name: string,
      version: number,
      audience: SkillAudienceAsked
    ) => {
      await Promise.resolve();
      if (audience === "company") {
        calls.push(`share ${name}@${version}`);
        const share = shareOf(name);
        shares.push(share);
        return share;
      }
      calls.push(`share ${name}@${version} with ${audience.team}`);
      const share = shareOf(name, {
        kind: "team",
        team: {
          id: audience.team,
          name: teams.find(({ id }) => id === audience.team)?.name ?? null,
        },
      });
      shares.push(share);
      return share;
    },
    retire: async (name: string, audience: SkillAudienceAsked) => {
      await Promise.resolve();
      calls.push(
        audience === "company"
          ? `retire ${name}`
          : `retire ${name} for ${audience.team}`
      );
    },
    approve: async (id: string) => {
      await Promise.resolve();
      calls.push(`approve ${id}`);
      if (approveRefusal !== undefined) {
        // Its person asked again meanwhile: the card is gone.
        requests = [];
        throw new Error(approveRefusal);
      }
      requests = [];
      return { ...request, status: "approved" as const, version: 1 };
    },
    remove: async (name: string) => {
      await Promise.resolve();
      calls.push(`remove ${name}`);
      owned.splice(
        owned.findIndex((skill) => skill.name === name),
        1
      );
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
    acceptProposal: async (workflow: string, version: number) => {
      await Promise.resolve();
      calls.push(`accept ${workflow}@${version}`);
      proposed = proposed.filter(({ basis }) => basis.workflow.id !== workflow);
      const added = { name: "send-report", version: 1, description: "Send" };
      owned.push(added);
      return added;
    },
    dismissProposal: async (workflow: string, version: number) => {
      await Promise.resolve();
      calls.push(`dismiss ${workflow}@${version}`);
      proposed = proposed.filter(({ basis }) => basis.workflow.id !== workflow);
    },
    decline: async (id: string) => {
      await Promise.resolve();
      calls.push(`decline ${id}`);
      requests = [];
      return { ...request, status: "declined" as const };
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
  return { calls, owned };
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

/** The buttons whose text is `label`, in page order. */
const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter(
    (each) => each.textContent === label
  );

/** Clicks `target`, then lets the page settle. */
const press = async (target: HTMLElement | undefined): Promise<void> => {
  if (target === undefined) {
    throw new Error("Nothing to press");
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
  await settle();
};

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
      superseded = false
    ) => ({
      ...shareOf(name),
      id: `share-${name}`,
      status,
      version,
      superseded,
    });
    await shown({
      admin: false,
      existing: [
        at("waiting", "pending", null),
        { ...at("added", "approved", 3), inUse: true },
        at("stuck", "approved", null),
        at("overtaken", "approved", null, true),
        at("refused", "declined", null),
      ],
    });

    expect({
      waiting: stateOf("waiting"),
      added: stateOf("added"),
      stuck: stateOf("stuck"),
      overtaken: stateOf("overtaken"),
      refused: stateOf("refused"),
    }).toStrictEqual({
      waiting: "Waiting for an admin",
      added: "Added to the company's skills.",
      stuck: "Approved, but not added to the company's skills yet.",
      overtaken:
        "Approved, but a later decision on this skill came before it was added.",
      refused: "Declined",
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

  it("reads the page again after an approval core refused, showing why and that the card is gone", async () => {
    const { calls } = await shown({
      admin: true,
      approveRefusal: "Out of reach.",
    });
    await click("Approve");
    const text = document.body.textContent ?? "";

    expect({
      calls,
      said: text.includes("Out of reach."),
      gone: text.includes("Nobody is waiting for you to decide a share."),
    }).toStrictEqual({
      calls: ["overview", "approve share-1", "overview"],
      said: true,
      gone: true,
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

  it("holds Delete while a skill is read into the editor, and drops a read of a skill gone from the page", async () => {
    const reading = Promise.withResolvers<boolean>();
    const { owned } = await shown({
      admin: true,
      held: { "read quote-a-tender": reading.promise },
    });
    await press(buttons("Edit")[0]);
    const deleteHeld = buttons("Delete").map((each) => each.disabled);
    // Deleted meanwhile from somewhere else; the page reads it gone.
    owned.splice(0, 1);
    await click("Approve");
    await act(async () => {
      reading.resolve(true);
      await Promise.resolve();
    });
    await settle();

    expect({
      deleteHeld,
      filled: editor().value.includes("quote-a-tender"),
    }).toStrictEqual({ deleteHeld: [true, true], filled: false });
  });

  it("says a share added since taken out of use is no longer the company's", async () => {
    await shown({
      admin: false,
      existing: [{ ...shareOf("gone-now"), status: "approved", version: 2 }],
    });

    expect(stateOf("gone-now")).toBe(
      "Added to the company's skills, and since taken out of use."
    );
  });

  it("lets its person ask again while an approved share is on its way, which leaves the approval standing", async () => {
    const { calls } = await shown({
      admin: false,
      existing: [{ ...shareOf("quote-a-tender"), status: "approved" }],
    });
    await click("Share with the company");

    expect(calls).toStrictEqual([
      "overview",
      "share quote-a-tender@2",
      "overview",
    ]);
  });

  it("returns focus to the editor after saving, and to the list after deleting", async () => {
    await shown({ admin: false });
    await click("Save");
    const afterSave = document.activeElement === editor();
    await press(buttons("Delete")[0]);
    await press(buttons("Delete for good").at(-1));

    expect({
      afterSave,
      afterDelete: document.activeElement?.textContent,
    }).toStrictEqual({ afterSave: true, afterDelete: "Your skills" });
  });

  it("keeps the page when reading it again after an action fails, and reads it again on Try again", async () => {
    const { calls } = await shown({ admin: false, overviewRefusals: [2] });
    await click("Save");
    const kept = {
      own: document.body.textContent?.includes("quote-a-tender"),
      said: document.body.textContent?.includes("Out of reach."),
    };
    await click("Try again");

    expect({
      kept,
      calls,
      said: document.body.textContent?.includes("Out of reach."),
      offered: buttons("Try again").length,
    }).toStrictEqual({
      kept: { own: true, said: true },
      calls: ["overview", "save name: my-skill", "overview", "overview"],
      said: false,
      offered: 0,
    });
  });

  it("offers Try again when the page can't be read at first, and shows it once it can", async () => {
    const { calls } = await shown({ admin: false, overviewRefusals: [1] });
    const refused = document.body.textContent?.includes("Out of reach.");
    await click("Try again");

    expect({
      refused,
      calls,
      own: document.body.textContent?.includes("quote-a-tender"),
    }).toStrictEqual({
      refused: true,
      calls: ["overview", "overview"],
      own: true,
    });
  });

  it("shares a skill with one of the person's teams from its menu, and says whom each share is for", async () => {
    const { calls } = await shown({
      admin: false,
      teams: [{ id: "t-1", name: "Sales" }],
    });
    await press(buttons("Share with a team")[0]);
    const offered = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent
    );
    await press(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === "Sales"
      )
    );
    const text = document.body.textContent ?? "";
    expect({
      offered,
      calls,
      forTeam: text.includes("For the team Sales"),
      states: [...document.querySelectorAll('[data-slot="badge"]')].map(
        (badge) => badge.textContent
      ),
    }).toStrictEqual({
      offered: ["Sales"],
      calls: ["overview", "share quote-a-tender@2 with t-1", "overview"],
      forTeam: true,
      states: ["Waiting for an admin"],
    });
  });

  it("offers no team to share with to someone in none", async () => {
    await shown({ admin: false });
    expect(buttons("Share with a team")).toStrictEqual([]);
  });

  it("shows an admin a team share's exact text, its team, and what approving replaces for the team's members", async () => {
    await shown({
      admin: true,
      waiting: {
        ...request,
        audience: { kind: "team", team: { id: "t-1", name: "Sales" } },
        replaces: "company",
      },
    });
    const text = document.body.textContent ?? "";
    expect({
      text: text.includes("Steps."),
      team: text.includes("For the team Sales"),
      replaces: text.includes(
        "Approving it replaces the company's own skill close-the-month for the members of Sales."
      ),
      forEveryone: text.includes("for everyone"),
    }).toStrictEqual({
      text: true,
      team: true,
      replaces: true,
      forEveryone: false,
    });
  });

  it("lists the person's teams' skills with their team, to be read, not retired", async () => {
    await shown({
      admin: false,
      company: [],
      teams: [{ id: "t-1", name: "Sales" }],
      team: [
        {
          name: "pitch-a-client",
          version: 3,
          description: "Pitch",
          team: { id: "t-1", name: "Sales" },
        },
      ],
    });
    const text = document.body.textContent ?? "";
    expect({
      listed: text.includes("pitch-a-client"),
      withTeam: text.includes("Sales, version 3"),
      retire: buttons("Retire").length,
      everyTeam: text.includes("Every team's skills"),
    }).toStrictEqual({
      listed: true,
      withTeam: true,
      retire: 0,
      everyTeam: false,
    });
  });

  it("lists an admin every team's skill in use, a team they aren't in too, and retires one for its team alone", async () => {
    const { calls } = await shown({
      admin: true,
      company: [],
      teamSkills: [
        {
          team: { id: "t-2", name: "Legal" },
          name: "check-a-contract",
          version: 2,
          onItsWay: null,
        },
        {
          team: { id: "t-3", name: null },
          name: "close-a-deal",
          version: null,
          onItsWay: "version",
        },
        {
          team: { id: "t-2", name: "Legal" },
          name: "file-a-claim",
          version: 4,
          onItsWay: "version",
        },
      ],
    });
    const text = document.body.textContent ?? "";
    await click("Retire");
    await press(
      [...document.querySelectorAll<HTMLElement>("button")].findLast(
        (each) => each.textContent === "Retire"
      )
    );
    expect({
      legal: text.includes("Legal, version 2"),
      gone: text.includes("t-3, not added yet"),
      replacing: text.includes("Legal, version 4; a new version is on its way"),
      calls,
    }).toStrictEqual({
      legal: true,
      gone: true,
      replacing: true,
      calls: ["overview", "retire check-a-contract for t-2", "overview"],
    });
  });

  it("says when a newer approved version of a company skill is on its way, beside the one in use", async () => {
    await shown({
      admin: false,
      company: ["file-expenses", "book-travel"],
      replacing: ["book-travel"],
    });
    const lines = [
      ...document.querySelectorAll('[data-slot="item-content"]'),
    ].map((item) => item.textContent);
    expect({
      replacing: lines.some(
        (line) =>
          line?.startsWith("book-travel") &&
          line.endsWith("Version 1; a new version is on its way")
      ),
      settled: lines.some(
        (line) =>
          line?.startsWith("file-expenses") && line.endsWith("Version 1")
      ),
    }).toStrictEqual({ replacing: true, settled: true });
  });

  it("keeps a skill whose retirement is on its way listed as in use, being taken out of use, with no Retire, for the company's and a team's alike", async () => {
    await shown({
      admin: true,
      company: ["file-expenses"],
      retiring: ["file-expenses"],
      teamSkills: [
        {
          team: { id: "t-2", name: "Legal" },
          name: "check-a-contract",
          version: 3,
          onItsWay: "retirement",
        },
      ],
    });
    const text = document.body.textContent ?? "";
    expect({
      company: text.includes("Version 1; being taken out of use"),
      team: text.includes("Legal, version 3; being taken out of use"),
      retire: buttons("Retire").length,
    }).toStrictEqual({ company: true, team: true, retire: 0 });
  });

  it("shows a skill proposed from the person's runs with what it rests on, and adds it to their skills", async () => {
    const { calls } = await shown({ admin: false, proposals: [proposal] });
    const before = document.body.textContent ?? "";
    await click("Add to your skills");
    const after = document.body.textContent ?? "";
    expect({
      calls,
      basis: before.includes(
        "Your last 5 runs of the workflow send-report, version 3, all succeeded."
      ),
      text: before.includes("When I ask for send report, start it."),
      proposedAfter: after.includes("Proposed for you"),
      own: buttons("Edit").length,
    }).toStrictEqual({
      calls: ["overview", "accept wf-1@3", "overview"],
      basis: true,
      text: true,
      proposedAfter: false,
      own: 3,
    });
  });

  it("dismisses a proposed skill", async () => {
    const { calls } = await shown({ admin: false, proposals: [proposal] });
    await click("Dismiss");
    expect({
      calls,
      proposed: (document.body.textContent ?? "").includes("Proposed for you"),
    }).toStrictEqual({
      calls: ["overview", "dismiss wf-1@3", "overview"],
      proposed: false,
    });
  });
});
