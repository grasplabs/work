// @vitest-environment happy-dom
import type { ChatMessage } from "@grasp-os/shared/chat";
import { modelErrors } from "@grasp-os/shared/models";
import type { ModelErrorCode } from "@grasp-os/shared/models";
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

import { ChatThread } from "./thread.tsx";

// A failed answer as the thread shows it: why it failed in people's
// words for every code the model gateway sends, never the gateway's own
// message, and Grasp could not be reached for anything else.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const at = "2026-10-22T10:00:00.000Z";

/** Each of the model gateway's error codes, which the type keeps complete. */
const everyCode: Readonly<Record<ModelErrorCode, true>> = {
  "model.invalid_call": true,
  "model.unconfigured": true,
  "model.not_allowed": true,
  "model.eu_only": true,
  "model.sensitive_data": true,
  "model.over_budget": true,
  "model.run_limit": true,
  "model.budget_busy": true,
  "model.queued": true,
  "model.rate_limited": true,
  "model.unpriced": true,
  "model.answer_too_long": true,
  "model.ledger_unavailable": true,
  "model.quota_policy_unavailable": true,
  "model.quota_policy_behind": true,
  "model.failed": true,
  "model.invalid_output": true,
};

/** The codes, as the model gateway's error family has them. */
const gatewayCodes = Object.keys(everyCode).flatMap((code) => {
  const known = modelErrors.codeOf({ code });
  return known === undefined ? [] : [known];
});

/**
 * A question and an answer that failed with each of `failures`, as core
 * sends them: the wire may carry a code this page doesn't know, or none.
 */
const failedWith = (failures: readonly unknown[]): ChatMessage[] =>
  failures.flatMap((failure, index) => {
    const answer: ChatMessage = {
      id: index * 2 + 2,
      role: "assistant",
      text: "",
      citations: [],
      code: [],
      end: "failed",
      at,
    };
    if (failure !== undefined) {
      Reflect.set(answer, "failure", failure);
    }
    return [{ id: index * 2 + 1, role: "user", text: "Any news?", at }, answer];
  });

let root: Root | undefined;

/** What the thread says about each failed answer in `messages`, in order. */
const alertsFor = async (messages: ChatMessage[]): Promise<string[]> => {
  const rootRoute = createRootRoute({
    component: () => (
      <ChatThread
        loaded
        messages={messages}
        onRetry={() => {
          // The test reads what the thread says, not a retry.
        }}
        output={null}
        partial={null}
        running={false}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core: {} },
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
  const said = [...document.querySelectorAll('[role="alert"]')].map(
    (alert) => alert.textContent ?? ""
  );
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
  return said;
};

/** A gateway error code, as "model.over_budget". */
const gatewayCode = /model\.[a-z_]+/u;

const unreachable = "Grasp could not be reached. Try again.";

describe("a failed answer", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says why in people's words for every code the model gateway sends", async () => {
    const said = await alertsFor(failedWith(gatewayCodes));
    const gatewayWords = new Set(
      gatewayCodes.map((code) => modelErrors.create(code).message)
    );

    expect(said).toHaveLength(Object.keys(everyCode).length);
    expect(
      said.filter(
        (words) =>
          words === "" ||
          words === unreachable ||
          gatewayCode.test(words) ||
          gatewayWords.has(words)
      )
    ).toStrictEqual([]);
  });

  it("says Grasp could not be reached for a code it doesn't know, or none", async () => {
    await expect(
      alertsFor(
        failedWith([
          "model.something_new",
          "<html><body>502 Bad Gateway</body></html>",
          undefined,
        ])
      )
    ).resolves.toStrictEqual([unreachable, unreachable, unreachable]);
  });
});
