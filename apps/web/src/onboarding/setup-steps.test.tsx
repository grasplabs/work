import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SetupStepBody } from "./setup-steps.tsx";
import type { SetupData } from "./setup-steps.tsx";
import { listeningOf } from "./setup.ts";

// What the onboarding's step tells the company's admin while Stephen talks
// to their people, from what it renders.

const today = "2026-10-14";

const view = (paused: boolean): OnboardingView => ({
  roster: null,
  plan: { start: "2026-10-12", days: 14 },
  progress: null,
  agreed: true,
  paused,
});

/** What the listening step says, as text without its markup. */
const listening = (paused: boolean): string => {
  const data: SetupData = {
    admin: "Ada",
    view: view(paused),
    documents: [],
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
        onStory={() => {}}
        parts={[]}
        percent={10}
        step="listening"
        today={today}
      />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ");
};

describe("the step while Stephen talks to the team", () => {
  it("says the interviews are paused, while Grasp paused them", () => {
    const paused = listening(true);
    expect(paused).toContain(
      "Paused: no link opens and none goes out. The links that are due go out once they run again."
    );
    expect(paused.indexOf("Paused:")).toBeLessThan(
      paused.indexOf("Day 3 of 14")
    );
    expect(listening(false)).not.toContain("Paused:");
  });
});
