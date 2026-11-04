// @vitest-environment happy-dom
import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import type {
  PendingWorkflowBindings,
  ListedWorkflowBindingApproval,
  WorkflowBindingTarget,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
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

import { formatDateTime } from "../format.ts";
import { FilesAndApps } from "./files-and-apps.tsx";

// A workflow's Files and apps tab against core's RPC as the page reaches
// it, faked: core keeps what an admin approves and revokes, and lists as
// waiting only the bindings no active approval serves, so what the tab
// shows after a change is what core holds. An admin approves a decision
// with the people and teams they pick, and a connector with the target
// core offers, each for the version listed, and revokes an approval once
// they confirm; anyone else sees what is approved, never what waits, and
// revokes nothing.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const workflow = "workflow-quotes";

const crmTarget: WorkflowBindingTarget = {
  kind: "connector",
  permissionId: "permission-crm",
  contract: "composio.hubspot@1",
};

/** What version 2 declares that waits, before anything is approved. */
const waiting: PendingWorkflowBindings["bindings"] = [
  {
    alias: "approval",
    kind: "decision",
    contractId: "invoice-approval",
    offered: [],
  },
  {
    alias: "crm",
    kind: "connector",
    contractId: "crm-contacts",
    offered: [{ target: crmTarget, label: "HUBSPOT: composio.hubspot@1" }],
  },
];

/** Version 2, which declares `approval` and `crm` as catalog bindings. */
const versionTwo: WorkflowResourceVersion = {
  resourceId: workflow,
  version: 2,
  definitionVersion: "1.0.0",
  profile: "grasp-open-workflow/1",
  definitionHash: "definition",
  contractHash: "contract",
  manifestHash: "manifest",
  bindings: [
    {
      alias: "approval",
      kind: "decision",
      resourceId: null,
      resourceVersion: null,
      contractId: "invoice-approval",
      fingerprint: "fingerprint-approval",
    },
    {
      alias: "crm",
      kind: "connector",
      resourceId: null,
      resourceVersion: null,
      contractId: "crm-contacts",
      fingerprint: "fingerprint",
    },
  ],
  actions: [],
  modelSteeredWrites: [],
  build: { executable: true, hash: "build" },
  author: "user-ada",
  createdAt: "2026-11-04T09:00:00.000Z",
};

/** Version 2 live, as core's lifecycle answers it. */
const lifecycle: WorkflowLifecycle = {
  workflowId: workflow,
  revision: 2,
  stage: "live",
  stageSet: false,
  draft: null,
  publishedVersion: 2,
  live: {
    version: 2,
    approvedBy: "user-admin",
    approvedAt: "2026-11-03T09:00:00.000Z",
    selfApproved: false,
  },
  paused: null,
  goLive: null,
  canChange: false,
  canDecide: false,
};

/** An admin's active approval of `crm` for version 2, as core lists it. */
const crmApproval = (id: string): ListedWorkflowBindingApproval => ({
  id,
  label: "HUBSPOT: composio.hubspot@1",
  alias: "crm",
  kind: "connector",
  contractId: "crm-contacts",
  fingerprint: "fingerprint",
  target: crmTarget,
  reviewedVersion: 2,
  status: "active",
  approvedBy: "user-grace",
  approvedAt: "2026-11-04T09:00:00.000Z",
});

/** An admin's active approval of `approval` for `version`, answered by `deciders`. */
const decisionApproval = (
  version: number,
  deciders: string[]
): ListedWorkflowBindingApproval => ({
  id: `approval-decision-${version}`,
  label: "",
  alias: "approval",
  kind: "decision",
  contractId: "invoice-approval",
  fingerprint: "fingerprint-approval",
  target: { kind: "decision", deciders },
  reviewedVersion: version,
  status: "active",
  approvedBy: "user-grace",
  approvedAt: "2026-11-04T09:00:00.000Z",
});

/**
 * Core as the tab reaches it, holding the active approvals `initial` and
 * keeping each approval and revocation asked of it; its first read of the
 * connections catalog answers only once `answerFirstCatalog` lets it, as a
 * cold catalog can take seconds.
 */
const fakeCore = (
  initial: ListedWorkflowBindingApproval[] = [],
  people = [
    { userId: "user-ada", name: "Ada Lovelace", email: "ada@acme.test" },
  ]
) => {
  const approved: { id: string; input: { alias: string } }[] = [];
  const revoked: { id: string; approval: string }[] = [];
  const active = [...initial];
  const asked: string[] = [];
  const firstCatalog = Promise.withResolvers<boolean>();
  let catalogReads = 0;
  const workflowResources = {
    knowledge: async () => await Promise.resolve([]),
    files: async () => await Promise.resolve([]),
    // As core answers them now: its active approvals, for version 2.
    bindings: async () => await Promise.resolve([...active]),
    pendingBindingsOf: async (
      id: string
    ): Promise<PendingWorkflowBindings[]> => {
      await Promise.resolve();
      asked.push("pendingBindingsOf");
      const done = new Set(
        active
          .filter(({ reviewedVersion }) => reviewedVersion === 2)
          .map(({ alias }) => alias)
      );
      const left = waiting.filter(({ alias }) => !done.has(alias));
      return left.length === 0
        ? []
        : [
            {
              workflow: { id, name: "Quotes" },
              version: 2,
              live: true,
              bindings: left,
            },
          ];
    },
    approveBinding: async (id: string, input: { alias: string }) => {
      await Promise.resolve();
      approved.push({ id, input });
      const approval = {
        ...crmApproval(`approval-${input.alias}-${approved.length}`),
        alias: input.alias,
      };
      active.push(approval);
      return approval;
    },
    revokeBinding: async (id: string, approval: string) => {
      await Promise.resolve();
      revoked.push({ id, approval });
      const at = active.findIndex((each) => each.id === approval);
      if (at !== -1) {
        active.splice(at, 1);
      }
    },
  };
  const session = {
    workflowResources,
    connections: {
      catalog: async () => {
        catalogReads += 1;
        if (catalogReads === 1) {
          await firstCatalog.promise;
        }
        return { entries: [] };
      },
      list: async () => await Promise.resolve([]),
    },
    workflows: {
      byConnection: async () => await Promise.resolve([]),
      teams: async () =>
        await Promise.resolve([{ id: "team-finance", name: "Finance" }]),
    },
    members: {
      list: async () => await Promise.resolve(people),
    },
  };
  return {
    session,
    approved,
    revoked,
    asked,
    answerFirstCatalog: () => {
      firstCatalog.resolve(true);
    },
  };
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

/** The tab on `session`, for an admin who approves when `approves`. */
const shown = async (
  session: ReturnType<typeof fakeCore>["session"],
  approves: boolean,
  people: ReadonlyMap<string, string> = new Map([
    ["user-grace", "Grace Hopper"],
  ])
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <FilesAndApps
        approves={approves}
        currentVersion={2}
        lifecycle={{ state: "ready", data: lifecycle }}
        names={{ people, me: "user-ada" }}
        versions={{ state: "ready", data: [versionTwo] }}
        workflow={workflow}
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
  await settled();
};

const press = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent.trim() === name
  );

const button = (name: string): HTMLButtonElement | undefined =>
  buttons(name)[0];

/**
 * What the binding listed as `alias` in the version that runs now says,
 * each piece of text apart.
 */
const listed = (alias: string): string[] | undefined => {
  const row = [
    ...document.querySelectorAll('[aria-label="Bindings of version 2"] > li'),
  ].find((each) => each.querySelector("code")?.textContent === alias);
  return row === undefined
    ? undefined
    : [...row.querySelectorAll("*")]
        .filter((each) => each.children.length === 0)
        .map((each) => each.textContent.trim());
};

/** What the tab says it did, each message apart. */
const saidNow = (): string[] =>
  [...document.querySelectorAll("output")].map((each) => each.textContent);

/** Opens the list of who answers and picks `name` from it. */
const pick = async (name: string) => {
  await press(button("Add who answers"));
  await press(
    [...document.querySelectorAll('[role="option"]')].find((each) =>
      each.textContent.trim().endsWith(name)
    )
  );
};

describe("a workflow's Files and apps tab", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets an admin approve a decision with the people, teams and roles they pick, and a connector with the target offered, until nothing waits, saying once what they did last", async () => {
    const { session, approved, answerFirstCatalog } = fakeCore();
    answerFirstCatalog();
    await shown(session, true);
    const unpicked = button("Approve approval")?.disabled;

    await pick("Ada Lovelace");
    await pick("Finance");
    await pick("Everyone with the Admin role");
    await press(button("Approve approval"));
    await press(button("Approve crm"));
    const waits = document.body.textContent.includes(
      "Waiting for your approval"
    );
    const said = saidNow();
    await press(button("Revoke crm"));
    // The dialog's own button, after the row's.
    await press(buttons("Revoke").at(-1));

    expect({
      unpicked,
      approved,
      waits,
      said,
      saidAfterRevoking: saidNow(),
    }).toStrictEqual({
      unpicked: true,
      approved: [
        {
          id: workflow,
          input: {
            alias: "approval",
            target: {
              kind: "decision",
              deciders: ["person:user-ada", "team:team-finance", "role:admin"],
            },
            reviewed: { version: 2 },
          },
        },
        {
          id: workflow,
          input: {
            alias: "crm",
            target: crmTarget,
            reviewed: { version: 2 },
          },
        },
      ],
      waits: false,
      said: ["Approved: crm."],
      saidAfterRevoking: ["Revoked: crm."],
    });
  });

  it("tells apart deciders of the same name by the end of their ID, picked and to remove", async () => {
    const { session, approved, answerFirstCatalog } = fakeCore(
      [],
      [
        { userId: "user-111111", name: "Ada Lovelace", email: "ada@acme.test" },
        {
          userId: "user-222222",
          name: "Ada Lovelace",
          email: "a.lovelace@acme.test",
        },
      ]
    );
    answerFirstCatalog();
    await shown(
      session,
      true,
      new Map([
        ["user-111111", "Ada Lovelace"],
        ["user-222222", "Ada Lovelace"],
      ])
    );

    await pick("ID …222222");
    // The other Ada is still told apart from the one picked.
    await pick("ID …111111");
    const removable = [
      button("Remove Ada Lovelace (ID …222222)") !== undefined,
      button("Remove Ada Lovelace (ID …111111)") !== undefined,
    ];
    await press(button("Approve approval"));

    expect({
      removable,
      deciders: approved.map(({ input }) =>
        "target" in input ? input.target : undefined
      ),
    }).toStrictEqual({
      removable: [true, true],
      deciders: [
        {
          kind: "decision",
          deciders: ["person:user-222222", "person:user-111111"],
        },
      ],
    });
  });

  it("lists an approved decision's deciders of the same name apart", async () => {
    const { session, answerFirstCatalog } = fakeCore([
      decisionApproval(2, ["person:user-222222", "person:user-111111"]),
    ]);
    answerFirstCatalog();
    await shown(
      session,
      true,
      new Map([
        ["user-111111", "Ada Lovelace"],
        ["user-222222", "Ada Lovelace"],
      ])
    );

    expect(listed("approval")).toContain(
      "Answered by Ada Lovelace (ID …222222) and Ada Lovelace (ID …111111)"
    );
  });

  it("keeps a connector approved once the tab's first, slower read of its apps lands after the approval", async () => {
    const { session, answerFirstCatalog } = fakeCore();
    await shown(session, true);
    await press(button("Approve crm"));
    const afterApproval = document.body.textContent.includes("Not connected");
    answerFirstCatalog();
    await settled();

    expect({
      afterApproval,
      afterFirstRead: document.body.textContent.includes("Not connected"),
    }).toStrictEqual({ afterApproval: false, afterFirstRead: false });
  });

  it("lists each binding of the version that runs now with what an admin approved and who, and lets an admin revoke one once they confirm, after which it waits again", async () => {
    // `approval` approved for version 1 only, which no longer runs.
    const { session, revoked, answerFirstCatalog } = fakeCore([
      crmApproval("approval-crm-first"),
      decisionApproval(1, ["role:admin"]),
    ]);
    answerFirstCatalog();
    await shown(session, true);
    const before = { crm: listed("crm"), approval: listed("approval") };

    await press(button("Revoke crm"));
    // The dialog's own button, after the row's.
    await press(buttons("Revoke").at(-1));

    expect({
      before,
      revoked,
      after: listed("crm"),
      waitsAgain: button("Approve crm") !== undefined,
    }).toStrictEqual({
      before: {
        crm: [
          "crm",
          "connector: crm-contacts",
          "HUBSPOT: composio.hubspot@1",
          `Approved by Grace Hopper on ${formatDateTime("2026-11-04T09:00:00.000Z")}`,
          "Revoke",
        ],
        approval: [
          "approval",
          "decision: invoice-approval",
          "Waiting for an admin's approval",
        ],
      },
      revoked: [{ id: workflow, approval: "approval-crm-first" }],
      after: [
        "crm",
        "connector: crm-contacts",
        "Waiting for an admin's approval",
      ],
      waitsAgain: true,
    });
  });

  it("shows anyone else what is approved, a decision's deciders by name, but never a way to revoke it", async () => {
    const { session, answerFirstCatalog } = fakeCore([
      crmApproval("approval-crm-first"),
      decisionApproval(2, [
        "person:user-grace",
        "team:team-finance",
        "role:admin",
      ]),
    ]);
    answerFirstCatalog();
    await shown(session, false);

    expect({
      approval: listed("approval")?.[2],
      crm: listed("crm"),
      revoke: buttons("Revoke crm").length,
    }).toStrictEqual({
      approval: "Answered by Grace Hopper, Finance, and Admin",
      crm: [
        "crm",
        "connector: crm-contacts",
        "HUBSPOT: composio.hubspot@1",
        `Approved by Grace Hopper on ${formatDateTime("2026-11-04T09:00:00.000Z")}`,
      ],
      revoke: 0,
    });
  });

  it("never asks core what waits for someone who doesn't approve", async () => {
    const { session, asked, answerFirstCatalog } = fakeCore();
    answerFirstCatalog();
    await shown(session, false);

    expect({
      asked,
      waits: document.body.textContent.includes("Waiting for your approval"),
    }).toStrictEqual({ asked: [], waits: false });
  });
});
