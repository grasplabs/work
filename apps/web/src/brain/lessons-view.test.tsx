// @vitest-environment happy-dom
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

import { LessonsView } from "./lessons-view.tsx";

// The Brain's lessons, against core's knowledge API as the page reaches
// it over RPC, faked: a lesson's versions show as far as their reader was
// part of them, an older one resting on turns they weren't in without its
// text, and a retirement goes against the revision read and reads the
// lesson again.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const at = "2026-10-20T09:00:00.000Z";

const summary = (revision: number, state: "candidate" | "retired") => ({
  id: "lesson-1",
  revision,
  scope: "session" as const,
  state,
  retiredBy: state === "retired" ? ("owner" as const) : null,
  instruction: "chat.turn failed 4 of its last 4 finished runs.",
  evidenceStatus: "supported" as const,
  taskType: "chat.turn",
  versions: [],
  updatedAt: at,
});

const shown = async (admin: boolean, refuse = false) => {
  const calls: string[] = [];
  let retired = false;
  const knowledge = {
    lessonsList: async () => {
      await Promise.resolve();
      calls.push("list");
      return [summary(retired ? 3 : 2, retired ? "retired" : "candidate")];
    },
    lessonsLineage: async ({ lessonId }: { lessonId: string }) => {
      await Promise.resolve();
      calls.push(`lineage ${lessonId}`);
      return {
        lesson: summary(retired ? 3 : 2, retired ? "retired" : "candidate"),
        versions: [
          {
            revision: 2,
            supersedes: 1,
            instruction: "chat.turn failed 4 of its last 4 finished runs.",
            evidenceStatus: "supported" as const,
            episodes: [
              {
                episodeId: "e-4",
                role: "supporting" as const,
                taskType: "chat.turn",
                execution: "failed" as const,
                result: "failure" as const,
                occurredAt: at,
              },
            ],
            createdAt: at,
          },
          {
            revision: 1,
            supersedes: null,
            instruction: null,
            evidenceStatus: null,
            episodes: [],
            createdAt: at,
          },
        ],
      };
    },
    lessonsRetire: async (input: {
      lessonId: string;
      expectedRevision: number;
    }) => {
      await Promise.resolve();
      calls.push(`retire ${input.lessonId}@${input.expectedRevision}`);
      if (refuse) {
        throw new Error("Someone changed this lesson meanwhile.");
      }
      retired = true;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { knowledge: typeof knowledge }) => Promise<T>
    ): Promise<T> => await action({ knowledge }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <LessonsView admin={admin} />,
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
  return { calls };
};

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find((each) =>
    each.textContent.startsWith(label)
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

describe(LessonsView, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows a lesson's versions as far as its reader was part of them, and retires it at the revision read", async () => {
    const { calls } = await shown(true);
    await settle();
    await press("chat.turn failed");
    const text = document.body.textContent;
    await press("Retire this lesson");
    const buttons = [...document.querySelectorAll("button")].map(
      (each) => each.textContent
    );

    expect({
      hiddenSaid: text.includes("It rests on turns you were not part of."),
      calls,
      retireStillOffered: buttons.includes("Retire this lesson"),
    }).toStrictEqual({
      hiddenSaid: true,
      calls: [
        "list",
        "lineage lesson-1",
        "retire lesson-1@2",
        "list",
        "lineage lesson-1",
      ],
      retireStillOffered: false,
    });
  });

  it("doesn't offer a shared chat's lesson's retirement to someone who isn't an admin", async () => {
    await shown(false);
    await settle();
    await press("chat.turn failed");
    const buttons = [...document.querySelectorAll("button")].map(
      (each) => each.textContent
    );

    expect(buttons).not.toContain("Retire this lesson");
  });

  it("keeps a refused retirement's reason on screen, reading nothing again", async () => {
    const { calls } = await shown(true, true);
    await settle();
    await press("chat.turn failed");
    await press("Retire this lesson");
    const buttons = [...document.querySelectorAll("button")].map(
      (each) => each.textContent
    );

    expect({
      calls,
      alert: document.querySelector('[role="alert"]')?.textContent,
      retireStillOffered: buttons.includes("Retire this lesson"),
    }).toStrictEqual({
      calls: ["list", "lineage lesson-1", "retire lesson-1@2"],
      alert: "Someone changed this lesson meanwhile.",
      retireStillOffered: true,
    });
  });
});
