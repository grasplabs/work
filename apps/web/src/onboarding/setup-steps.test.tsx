import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { noChoices } from "@grasp-os/shared/onboarding-choices";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SetupStepBody } from "./setup-steps.tsx";
import type { SetupData } from "./setup-steps.tsx";
import { listeningOf } from "./setup.ts";
import type { SetupStep } from "./setup.ts";

// What the onboarding's step tells the company's admin while Stephen talks
// to their people, from what it renders.

const today = "2026-10-14";

const view = (paused: boolean, sponsor: string | null): OnboardingView => ({
  roster: null,
  plan: { start: "2026-10-12", days: 14 },
  progress: null,
  agreed: true,
  paused,
  sponsor,
});

/** What a step says, as text without its markup. */
const said = (
  step: SetupStep,
  {
    paused = false,
    settled = [],
    sponsor = null,
  }: { paused?: boolean; settled?: "mail"[]; sponsor?: string | null }
): string => {
  const data: SetupData = {
    admin: "Ada",
    view: view(paused, sponsor),
    documents: [],
    sendingDomain: "mail.example.test",
    gate: {
      open: false,
      closedSince: null,
      threshold: 80,
      known: 10,
      parts: [],
      ready: false,
      over: false,
      openedAt: null,
      staff: null,
    },
    choices: noChoices,
    signIn: ["microsoft"],
    identity: {
      userId: "ada",
      email: "ada@acme.test",
      name: "Ada",
      role: "admin",
      teams: [],
      staff: false,
      expiresAt: "2026-10-15T00:00:00Z",
    },
  };
  return renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <SetupStepBody
        cramped={false}
        data={data}
        go={() => {}}
        listening={listeningOf(
          { roster: null, plan: data.view.plan, progress: null },
          today
        )}
        message={null}
        onMadeWay={() => {}}
        onMessage={() => {}}
        onSettle={() => {}}
        onStory={() => {}}
        parts={[]}
        percent={10}
        settled={settled}
        step={step}
        today={today}
      />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ");
};

describe("the step while Stephen talks to the team", () => {
  it("says the interviews are paused, while Grasp paused them", () => {
    const paused = said("listening", { paused: true });
    expect(paused).toContain(
      "Paused: no link opens and none goes out. The links that are due go out once they run again."
    );
    expect(paused.indexOf("Paused:")).toBeLessThan(
      paused.indexOf("Day 3 of 14")
    );
    expect(said("listening", {})).not.toContain("Paused:");
  });

  it("asks the admin to let Grasp's mail through, naming the sending domain, until they say it's done", () => {
    const open = said("listening", {});
    expect({
      asked: open.includes("Let Grasp’s mail through"),
      named: open.includes(
        "Apply it if the sender’s domain is mail.example.test."
      ),
      done: said("listening", { settled: ["mail"] }).includes(
        "Let Grasp’s mail through"
      ),
    }).toStrictEqual({ asked: true, named: true, done: false });
  });
});

describe("what needs the admin", () => {
  it("counts letting Grasp's mail through, and lets them go on once it's done", () => {
    const open = said("review", {});
    const done = said("review", { settled: ["mail"] });
    expect({
      open: [
        open.includes("Just one thing for you"),
        open.includes("Continue"),
      ],
      done: [
        done.includes("Nothing needs you"),
        done.includes("Settled: It’s done"),
        done.includes("Continue"),
      ],
    }).toStrictEqual({ open: [true, false], done: [true, true, true] });
  });
});

describe("the welcome", () => {
  it.each([
    {
      sponsor: "Anna",
      says: "Anna told me a lot about your company in our first conversation. Before we start, which language do you prefer?",
    },
    // The kickoff named no one: no one is named.
    { sponsor: null, says: "Ada, I’m Stephen Before we start, which language" },
  ])(
    "names the sponsor only when the kickoff gave a name ($sponsor)",
    ({ sponsor, says }) => {
      expect(said("welcome", { sponsor })).toContain(says);
    }
  );
});
