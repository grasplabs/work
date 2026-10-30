// @vitest-environment happy-dom
import {
  exceptionInputSchema,
  ruleInputSchema,
  ruleStatusSchema,
} from "@grasp-os/shared/policies";
import type {
  ExceptionInput,
  PolicyBook,
  PolicyRule,
  RuleInput,
} from "@grasp-os/shared/policies";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { LandscapeApp } from "../landscape/landscape.ts";
import {
  ConditionEditor,
  draftOf,
  editsPolicies,
  freshCondition,
  RuleActions,
  RuleExceptions,
  ruleInputOf,
  RuleStatusControl,
} from "./policy-editing.tsx";
import type { DraftCondition } from "./policy-editing.tsx";

// Changing the policies from their pages: who may, what the rule dialog
// hands core, and a rule's controls against core's `policies` as the page
// reaches it over RPC (the boundary from the web app), faked with core's
// own schemas, so what the page sends is checked as core checks it. The
// page reads the book again after each change.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const outsideEu: PolicyRule = {
  id: "rule-1",
  name: "Customer data stays in the EU",
  description: "",
  conditions: [
    { field: "data", values: ["customer"] },
    { field: "hosting", op: "outside", values: ["eu"] },
  ],
  effect: "block",
  status: "watching",
  policyId: null,
  createdBy: "user-1",
  createdAt: "2026-10-20T08:00:00.000Z",
};

const chatGpt: LandscapeApp = {
  id: "app-chatgpt",
  name: "ChatGPT",
  vendor: "OpenAI",
  category: null,
  description: null,
  aiType: "Core",
  dataExposure: ["customer"],
  dataExposureReason: "",
  hosting: ["us"],
  users: 47,
  owner: null,
  firstSeen: "2026-09-01T10:00:00.000Z",
  connectionIds: [],
  use: { sources: ["native"], engines: [] },
  blocked: false,
  flagged: false,
  policySource: null,
};

/** Core's `policies` over one book, refusing what core's schemas refuse. */
const fakePolicies = () => {
  const sent: {
    updated: RuleInput[];
    turned: [string, string][];
    granted: ExceptionInput[];
  } = {
    updated: [],
    turned: [],
    granted: [],
  };
  let book: PolicyBook = { policies: [], rules: [outsideEu], exceptions: [] };
  const policies = {
    book: async (): Promise<PolicyBook> => await Promise.resolve(book),
    updateRule: async (
      ruleId: string,
      input: RuleInput
    ): Promise<PolicyRule> => {
      const parsed = ruleInputSchema.parse(input);
      sent.updated.push(input);
      const rule = { ...outsideEu, ...parsed, id: ruleId };
      book = { ...book, rules: [rule] };
      return await Promise.resolve(rule);
    },
    setRuleStatus: async (
      ruleId: string,
      status: string
    ): Promise<PolicyRule> => {
      const parsed = ruleStatusSchema.parse(status);
      sent.turned.push([ruleId, parsed]);
      const rule = { ...(book.rules[0] ?? outsideEu), status: parsed };
      book = { ...book, rules: [rule] };
      return await Promise.resolve(rule);
    },
    removeRule: async (): Promise<void> => {
      book = { ...book, rules: [], exceptions: [] };
      await Promise.resolve();
    },
    grantException: async (input: ExceptionInput) => {
      const parsed = exceptionInputSchema.parse(input);
      sent.granted.push(input);
      const exception = {
        ...parsed,
        grantedBy: "user-1",
        grantedAt: "2026-10-28T08:00:00.000Z",
      };
      book = {
        ...book,
        exceptions: [
          ...book.exceptions.filter(({ appId }) => appId !== parsed.appId),
          exception,
        ],
      };
      return await Promise.resolve(exception);
    },
    revokeException: async (ruleId: string, appId: string): Promise<void> => {
      book = {
        ...book,
        exceptions: book.exceptions.filter(
          (each) => each.ruleId !== ruleId || each.appId !== appId
        ),
      };
      await Promise.resolve();
    },
  };
  return { sent, policies };
};

let root: Root | undefined;

const isBook = (data: unknown): data is PolicyBook =>
  typeof data === "object" && data !== null && "rules" in data;

/** A rule's page as an admin has it: its status, its controls and its exceptions. */
const opened = async (
  policies: ReturnType<typeof fakePolicies>["policies"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { policies: typeof policies }) => Promise<T>
    ): Promise<T> => await action({ policies }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await policies.book(),
  });
  const RulePage = () => {
    const loaded: unknown = useRouterState({
      select: ({ matches }) => matches.at(0)?.loaderData,
    });
    const rule = isBook(loaded) ? loaded.rules[0] : undefined;
    if (!isBook(loaded) || rule === undefined) {
      return <p>No rule</p>;
    }
    return (
      <div>
        <output>{rule.status}</output>
        <RuleActions policies={loaded.policies} rule={rule} />
        <RuleStatusControl rule={rule} />
        <RuleExceptions
          apps={[chatGpt]}
          edits
          exceptions={loaded.exceptions}
          rule={rule}
        />
      </div>
    );
  };
  rootRoute.update({ component: RulePage });
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

const click = async (name: string): Promise<void> => {
  const found = [...document.querySelectorAll("button")].findLast(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
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

/** Types `value` into the field labelled `label`, as a person would. */
const fill = async (label: string, value: string): Promise<void> => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  const field = document.querySelector(
    `#${CSS.escape(labelled?.htmlFor ?? "")}`
  );
  if (
    !(
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement ||
      field instanceof HTMLSelectElement
    )
  ) {
    throw new Error(`No field ${label}`);
  }
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(field) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value
    );
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    await Promise.resolve();
  });
};

/** What the page shows: the rule's status and the exceptions listed. */
const shown = () => ({
  status: document.querySelector("output")?.textContent,
  exceptions: [...document.querySelectorAll("li")].map(
    (each) => each.querySelector(".font-medium")?.textContent
  ),
});

/** Two vendor conditions, as a rule being written holds them. */
const Editor = () => {
  const [conditions, setConditions] = useState<DraftCondition[]>(() => [
    { ...freshCondition("vendor"), typed: "OpenAI", values: ["OpenAI"] },
    {
      ...freshCondition("vendor"),
      typed: "DeepSeek, Moonshot",
      values: ["DeepSeek", "Moonshot"],
    },
  ]);
  return (
    <ConditionEditor
      conditions={conditions}
      disabled={false}
      onChange={setConditions}
    />
  );
};

describe("changing the policies", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("is for the organization's own admins: not members, builders or Grasp staff", () => {
    expect({
      admin: editsPolicies({ role: "admin", staff: false }),
      builder: editsPolicies({ role: "builder", staff: false }),
      member: editsPolicies({ role: "user", staff: false }),
      staff: editsPolicies({ role: "admin", staff: true }),
    }).toStrictEqual({
      admin: true,
      builder: false,
      member: false,
      staff: false,
    });
  });

  it("hands core a new rule only once each condition names what it checks for", () => {
    const fresh = draftOf(undefined, null);
    const picked = {
      ...fresh,
      name: "  No unowned AI  ",
      conditions: [
        { ...freshCondition("data"), values: ["customer"] },
        freshCondition("owner"),
        { ...freshCondition("people"), moreThan: 10 },
        { ...freshCondition("vendor"), values: ["OpenAI"] },
      ],
      excerpt: "Ignored for a rule made by hand",
    };

    expect({
      fresh: ruleInputOf(fresh),
      none: ruleInputOf({ ...picked, conditions: [] }),
      picked: ruleInputOf(picked),
      valid: ruleInputSchema.safeParse(ruleInputOf(picked)).success,
    }).toStrictEqual({
      fresh: undefined,
      none: undefined,
      picked: {
        name: "No unowned AI",
        description: "",
        conditions: [
          { field: "data", values: ["customer"] },
          { field: "owner" },
          { field: "people", moreThan: 10 },
          { field: "vendor", op: "is", values: ["OpenAI"] },
        ],
        effect: "flag",
        status: "watching",
        policyId: null,
      },
      valid: true,
    });
  });

  it("turns a rule that blocks on from its page once it is confirmed, sending core its status alone", async () => {
    const { sent, policies } = fakePolicies();
    await opened(policies);

    await click("Active");
    const asked = {
      shown: shown().status,
      dialog: document.querySelector('[role="alertdialog"]')?.textContent,
    };
    await click("Start blocking");

    expect({
      asked: {
        shown: asked.shown,
        confirms: asked.dialog?.includes("blocked"),
      },
      shown: shown().status,
      updated: sent.updated,
      turned: sent.turned,
    }).toStrictEqual({
      asked: { shown: "watching", confirms: true },
      shown: "active",
      updated: [],
      turned: [[outsideEu.id, "active"]],
    });
  });

  it("keeps each condition's own vendors when the one before it is removed", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      root = createRoot(host);
      root.render(
        <I18nProvider i18n={i18n}>
          <Editor />
        </I18nProvider>
      );
      await Promise.resolve();
    });
    const before = [...document.querySelectorAll("input")].map(
      (each) => each.value
    );
    // The first of the two: the other must keep its own vendors.
    const first = document.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Vendor"]'
    );
    await act(async () => {
      first?.click();
      await Promise.resolve();
    });

    expect({
      before,
      after: [...document.querySelectorAll("input")].map((each) => each.value),
    }).toStrictEqual({
      before: ["OpenAI", "DeepSeek, Moonshot"],
      after: ["DeepSeek, Moonshot"],
    });
  });

  it("lets one app break the rule until a day, and ends that when revoked", async () => {
    const { sent, policies } = fakePolicies();
    await opened(policies);

    await click("Grant an exception");
    await fill("Why", "Pilot with the sales team");
    await fill("Until", "2099-01-31");
    await click("Grant");
    const granted = shown().exceptions;
    await click("Revoke the exception for ChatGPT");

    expect({
      granted,
      sent: sent.granted,
      revoked: shown().exceptions,
    }).toStrictEqual({
      granted: ["ChatGPT"],
      sent: [
        {
          ruleId: outsideEu.id,
          appId: chatGpt.id,
          reason: "Pilot with the sales team",
          until: "2099-01-31",
        },
      ],
      revoked: [],
    });
  });
});
