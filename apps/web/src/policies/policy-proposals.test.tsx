// @vitest-environment happy-dom
import type { PolicyDocument, RuleProposal } from "@grasp-os/shared/policies";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ProposalChoice,
  ProposalDecided,
  ReadAgain,
} from "./policy-proposals.tsx";

// What an admin decides about what Grasp read in a policy, against core's
// `policies` as the page reaches it over RPC (the boundary from the web
// app), faked: keeping or leaving out a proposal decides it once, the page
// reads the policy again afterwards and shows the decision, what core
// refuses is said, and a failed reading is read again.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const proposal = (id: string, name: string): RuleProposal => ({
  id,
  name,
  description: "",
  conditions: [{ field: "owner" }],
  effect: "flag",
  excerpt: "Every tool has an owner.",
  decision: "open",
});

/** Core's `policies` for one policy, refusing `refusing` as core words it. */
const fakePolicies = (
  status: PolicyDocument["status"],
  { refusing }: { refusing?: string } = {}
) => {
  const calls: string[] = [];
  let policy: PolicyDocument = {
    id: "policy-1",
    title: "Acceptable use of AI",
    fileName: "ai.txt",
    uploadedBy: "user-1",
    uploadedAt: "2026-10-28T08:00:00.000Z",
    status,
    proposals: [proposal("p-1", "Owned tools"), proposal("p-2", "Flag it")],
    unchecked: [],
  };
  const decide = async (
    proposalId: string,
    decision: RuleProposal["decision"]
  ): Promise<void> => {
    calls.push(`${decision} ${proposalId}`);
    await Promise.resolve();
    if (proposalId === refusing) {
      throw new Error("Only the organization's own admins can do that.");
    }
    policy = {
      ...policy,
      proposals: policy.proposals.map((each) =>
        each.id === proposalId ? { ...each, decision } : each
      ),
    };
  };
  return {
    calls,
    policies: {
      get: async (): Promise<PolicyDocument> => await Promise.resolve(policy),
      acceptProposal: async (_policyId: string, proposalId: string) => {
        await decide(proposalId, "accepted");
      },
      rejectProposal: async (_policyId: string, proposalId: string) => {
        await decide(proposalId, "rejected");
      },
      readAgain: async (policyId: string) => {
        calls.push(`read ${policyId}`);
        policy = { ...policy, status: "review" };
        return await Promise.resolve(policy);
      },
    },
  };
};

let root: Root | undefined;

const isPolicy = (data: unknown): data is PolicyDocument =>
  typeof data === "object" && data !== null && "proposals" in data;

/** A policy's proposals as an admin's page shows them. */
const opened = async (
  policies: ReturnType<typeof fakePolicies>["policies"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { policies: typeof policies }) => Promise<T>
    ): Promise<T> => await action({ policies }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await policies.get(),
  });
  const PolicyPage = () => {
    const loaded: unknown = useRouterState({
      select: ({ matches }) => matches.at(0)?.loaderData,
    });
    if (!isPolicy(loaded)) {
      return null;
    }
    return (
      <div>
        <output>{loaded.status}</output>
        {loaded.status === "failed" ? <ReadAgain policyId={loaded.id} /> : null}
        {loaded.proposals.map((each) => (
          <article key={each.id}>
            <h3>{each.name}</h3>
            <ProposalDecided decision={each.decision} />
            {each.decision === "open" ? (
              <ProposalChoice policyId={loaded.id} proposal={each} />
            ) : null}
          </article>
        ))}
      </div>
    );
  };
  rootRoute.update({ component: PolicyPage });
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

/** Lets every pending promise and render settle, the page's reload too. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 10);
    await promise;
  });
};

/** Clicks `name` in the proposal called `proposalName`, or anywhere without one. */
const click = async (name: string, proposalName?: string): Promise<void> => {
  const scope =
    proposalName === undefined
      ? document.body
      : [...document.querySelectorAll("article")].find(
          (each) => each.querySelector("h3")?.textContent === proposalName
        );
  const found = [...(scope?.querySelectorAll("button") ?? [])].find(
    (each) => each.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

/** Each proposal as shown: its name, then what was decided or the choices left. */
const shown = () => ({
  status: document.querySelector("output")?.textContent,
  proposals: [...document.querySelectorAll("article")].map((each) =>
    [...each.querySelectorAll("h3, [data-slot='badge'], button")].map((part) =>
      part.textContent?.trim()
    )
  ),
  refused: document.querySelector('[role="alert"]')?.textContent ?? null,
});

describe("deciding what Grasp read in a policy", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("keeps one proposal and leaves out the other, each once, as the page reads them again", async () => {
    const { calls, policies } = fakePolicies("review");
    await opened(policies);
    const open = shown();

    await click("Keep", "Owned tools");
    await click("Leave out", "Flag it");

    expect({ open, decided: shown(), calls }).toStrictEqual({
      open: {
        status: "review",
        proposals: [
          ["Owned tools", "Keep", "Leave out"],
          ["Flag it", "Keep", "Leave out"],
        ],
        refused: null,
      },
      decided: {
        status: "review",
        proposals: [
          ["Owned tools", "Kept"],
          ["Flag it", "Left out"],
        ],
        refused: null,
      },
      calls: ["accepted p-1", "rejected p-2"],
    });
  });

  it("says why core refused, leaving the proposal open", async () => {
    const { policies } = fakePolicies("review", { refusing: "p-1" });
    await opened(policies);

    await click("Keep", "Owned tools");

    expect(shown()).toStrictEqual({
      status: "review",
      proposals: [
        ["Owned tools", "Keep", "Leave out"],
        ["Flag it", "Keep", "Leave out"],
      ],
      refused: "Only the organization's own admins can do that.",
    });
  });

  it("reads a policy again whose reading failed", async () => {
    const { calls, policies } = fakePolicies("failed");
    await opened(policies);

    await click("Read it again");

    expect({ status: shown().status, calls }).toStrictEqual({
      status: "review",
      calls: ["read policy-1"],
    });
  });
});
