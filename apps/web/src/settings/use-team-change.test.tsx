// @vitest-environment happy-dom
import { staffListTeamRefusals } from "@grasp-os/shared/onboarding";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createTeam, deleteTeam } from "./team-changes.ts";
import { useTeamChange } from "./use-team-change.ts";

// A team change Settings › Members sends to Better Auth, as the page
// tells the admin why it didn't go through: the staff list's own refusals
// each by their own code (core's auth.ts, GRA-2055), never one for another
// or for any other conflict.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Better Auth answering every change with `status` and `body`. */
const answering = (status: number, body: unknown): void => {
  vi.stubGlobal(
    "fetch",
    async () => await Promise.resolve(Response.json(body, { status }))
  );
};

type Run = ReturnType<typeof useTeamChange>["run"];

/** The hook's `run`, handed out once the page has it. */
const Probe = ({ onRun }: { onRun: (run: Run) => void }) => {
  const { run } = useTeamChange(async () => {
    await Promise.resolve();
  });
  useEffect(() => {
    onRun(run);
  }, [onRun, run]);
  return null;
};

/** What the page says of `change` refused as Better Auth answers it. */
const said = async (change: () => Promise<void>): Promise<string> => {
  let run: Run | undefined;
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <I18nProvider i18n={i18n}>
        <Probe
          onRun={(given) => {
            run = given;
          }}
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  let refused: string | undefined;
  await act(async () => {
    refused = await run?.(change, "Couldn't change the team.");
  });
  root.unmount();
  return refused ?? "";
};

describe("a team change Settings refuses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says each staff-list refusal by its own code, and any other conflict as the change that failed", async () => {
    answering(409, {
      code: staffListTeamRefusals.onList,
      message: "The team is on the staff list.",
    });
    const deleting = await said(async () => {
      await deleteTeam("team-1");
    });
    answering(409, {
      code: staffListTeamRefusals.notMadeYet,
      message: "A team on the staff list has this name.",
    });
    const creating = await said(async () => {
      await createTeam("Sales");
    });
    answering(409, { code: "SOMETHING_ELSE", message: "Conflict" });
    const other = await said(async () => {
      await createTeam("Sales");
    });

    expect({ deleting, creating, other }).toStrictEqual({
      deleting:
        "This team is on the staff list. Take it off there and confirm the list first.",
      creating:
        "A team on the staff list has this name. It appears here once the staff list is confirmed.",
      other: "Couldn't change the team.",
    });
  });
});
