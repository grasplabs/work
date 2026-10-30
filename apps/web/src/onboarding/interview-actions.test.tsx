// @vitest-environment happy-dom
import type { LinkToSend } from "@grasp-os/shared/onboarding";
import type { StaffInterview } from "@grasp-os/shared/onboarding-staff";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { FailedMailNotice } from "./failed-mail.tsx";
import { InterviewActions } from "./interview-actions.tsx";

// What staff do for one interview, and what the company's admin is told
// of a failed mail, against core's onboarding APIs as the page reaches
// them over RPC (the boundary from the web app), faked: sending a failed
// mail again clears it, and a new start is asked, so what the page shows
// after is what core holds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const oli: StaffInterview = {
  person: "oli",
  name: "Oli",
  team: "Ops",
  startedAt: null,
  completedAt: null,
  state: null,
  mode: null,
  rating: null,
  interviewer: null,
  texts: [],
  counts: { said: 0, facts: 0, out: 0, approved: 0 },
  participatedAt: null,
  withdrawnAt: null,
  failedMail: {
    kind: "link",
    reason: "E_RECIPIENT_SUPPRESSED",
    at: "2026-10-30T09:00:00.000Z",
  },
};

/** Core's staff onboarding API on oli's interview, and each change asked. */
const fakeStaff = () => {
  const asked: string[][] = [];
  let read = oli;
  const onboardingStaff = {
    interview: async (): Promise<StaffInterview> => {
      await Promise.resolve();
      return read;
    },
    sendMailAgain: async (person: string): Promise<void> => {
      await Promise.resolve();
      asked.push(["again", person]);
      read = { ...read, failedMail: null };
    },
    newStart: async (person: string): Promise<void> => {
      await Promise.resolve();
      asked.push(["new start", person]);
    },
  };
  return { session: { onboardingStaff }, asked };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** `page`, in the page's language. */
const rendered = async (page: ReactNode): Promise<void> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<I18nProvider i18n={i18n}>{page}</I18nProvider>);
    await Promise.resolve();
  });
};

/** Oli's interview page, read through `session` and read again after each change. */
const shownInterview = async (
  session: ReturnType<typeof fakeStaff>["session"]
): Promise<void> => {
  const core = {
    withSession: async <R,>(
      run: (reached: typeof session) => Promise<R>
    ): Promise<R> => await run(session),
  };
  const rootRoute = createRootRoute({
    loader: async () => await session.onboardingStaff.interview(),
    component: () => <InterviewActions read={rootRoute.useLoaderData()} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  await rendered(<RouterProvider router={router} />);
  await act(async () => {
    await router.load();
  });
};

const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (button === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

const text = (): string => document.body.textContent ?? "";

const link = (
  person: string,
  failedMail: LinkToSend["failedMail"]
): LinkToSend => ({
  person,
  name: person === "oli" ? "Oli" : "Ona",
  team: "Ops",
  email: `${person}@acme.test`,
  path: `/interview#${person}`,
  fresh: false,
  failedMail,
});

describe("Help them in", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows staff why someone's mail failed, and sends it again", async () => {
    const { session, asked } = fakeStaff();
    await shownInterview(session);
    expect(text()).toContain("Their link failed on");
    expect(text()).toContain("E_RECIPIENT_SUPPRESSED");

    await press("Send again");

    expect({
      asked,
      after: text().includes("No mail to them failed."),
    }).toStrictEqual({ asked: [["again", "oli"]], after: true });
  });

  it("gives someone a new start only once staff confirm it", async () => {
    const { session, asked } = fakeStaff();
    await shownInterview(session);

    await press("Start over on a new device");
    await press("Cancel");
    const afterCancel = [...asked];
    await press("Start over on a new device");
    await press("Delete and start over");

    expect({ afterCancel, asked }).toStrictEqual({
      afterCancel: [],
      asked: [["new start", "oli"]],
    });
  });

  it("tells the company's admin whose mail failed, by name only", async () => {
    await rendered(
      <FailedMailNotice
        links={[
          link("oli", {
            kind: "link",
            reason: "E_RECIPIENT_SUPPRESSED",
            at: "2026-10-30T09:00:00.000Z",
          }),
          link("ona", null),
        ]}
      />
    );

    expect({
      named: text().includes("Our email didn’t reach Oli."),
      others: text().includes("Ona"),
      reason: text().includes("SUPPRESSED"),
      address: text().includes("@"),
    }).toStrictEqual({
      named: true,
      others: false,
      reason: false,
      address: false,
    });
  });
});
