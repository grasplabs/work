import { screenErrors } from "@grasp-os/shared/screens";
import type { ScreenTarget } from "@grasp-os/shared/screens";
import { describe, expect, it } from "vite-plus/test";

import { navigationPolicy, stayCooldownMs } from "./navigation-policy.ts";
import type { PageNavigate } from "./navigation-policy.ts";

// What one start of a screen's frame may do to the page: the person's own
// moves win over the App's, a person who chose to stay isn't asked again
// and again, and a screen can't fill the history as it mounts.

const note: ScreenTarget = { screen: "note", route: "note", input: {} };

/** How a navigation ended: `went`, or the code it was refused with. */
const answerOf = async (navigation: Promise<void>): Promise<string> => {
  try {
    await navigation;
    return "went";
  } catch (error) {
    return screenErrors.codeOf(error) ?? "failed";
  }
};

/** A page at `/start`, the person active, and a clock to move. */
const pageAt = () => {
  const state = {
    here: "/start",
    going: "/start",
    activated: true,
    now: 0,
    went: new Array<{ replace: boolean }>(),
    /** Whether the person stays on the next navigation (the leave dialog). */
    stays: false,
  };
  const go: PageNavigate = async (_target, replace) => {
    await Promise.resolve();
    state.went.push({ replace });
    if (state.stays) {
      throw screenErrors.create("screen.navigation_cancelled");
    }
  };
  const policy = navigationPolicy(go, {
    location: () => ({ here: state.here, going: state.going }),
    activated: () => state.activated,
    now: () => state.now,
  });
  const asked = async (replace = false): Promise<string> => {
    try {
      await policy.navigate(note, replace);
      return "went";
    } catch (error) {
      return screenErrors.codeOf(error) ?? "failed";
    }
  };
  return { state, policy, asked };
};

describe("a screen's navigation of the page", () => {
  it("goes nowhere, replacing nothing, once the page left the frame's page or is on its way elsewhere", async () => {
    const { state, asked } = pageAt();
    state.going = "/inbox";
    const whileGoing = await asked(true);
    // Settled where the person went.
    state.here = "/inbox";
    const afterLeaving = await asked(true);
    // On the way back to the frame's page, but not there yet.
    state.going = "/start";
    const comingBack = await asked(true);
    expect({
      whileGoing,
      afterLeaving,
      comingBack,
      went: state.went,
    }).toStrictEqual({
      comingBack: "screen.navigation_cancelled",
      whileGoing: "screen.navigation_cancelled",
      afterLeaving: "screen.navigation_cancelled",
      went: [],
    });
  });

  it("asks the person once: after they stay, the screen's next navigations are refused unasked until its edits go or a while passed", async () => {
    const { state, policy, asked } = pageAt();
    state.stays = true;
    const first = await asked();
    state.stays = false;
    const again = await asked();
    const later = await asked();
    policy.guardChanged(false);
    const afterSaving = await asked();
    expect({
      first,
      again,
      later,
      afterSaving,
      asked: state.went.length,
    }).toStrictEqual({
      first: "screen.navigation_cancelled",
      again: "screen.navigation_cancelled",
      later: "screen.navigation_cancelled",
      afterSaving: "went",
      asked: 2,
    });
  });

  it("refuses the navigation waiting on the dialog once the person stays, whether or not the page's own settles", async () => {
    let went = 0;
    const policy = navigationPolicy(
      async () => {
        went += 1;
        // The page's navigation, held by its blocker, never settles.
        await Promise.withResolvers<never>().promise;
      },
      {
        location: () => ({ here: "/start", going: "/start" }),
        activated: () => true,
        now: () => 0,
      }
    );
    const waiting = answerOf(policy.navigate(note, false));
    await Promise.resolve();
    policy.stayed();
    const answered = await waiting;
    const next = await answerOf(policy.navigate(note, false));
    expect({ answered, next, went }).toStrictEqual({
      answered: "screen.navigation_cancelled",
      next: "screen.navigation_cancelled",
      went: 1,
    });
  });

  it("asks again once the while after staying passed", async () => {
    const { state, asked } = pageAt();
    state.stays = true;
    await asked();
    state.stays = false;
    state.now = stayCooldownMs - 1;
    const tooSoon = await asked();
    state.now = stayCooldownMs;
    const after = await asked();
    expect({ tooSoon, after }).toStrictEqual({
      tooSoon: "screen.navigation_cancelled",
      after: "went",
    });
  });

  it("goes once, at most, without the person acting; each act of theirs lets it go again", async () => {
    const { state, asked } = pageAt();
    state.activated = false;
    const unprompted = await asked();
    const twice = await asked();
    state.activated = true;
    const clicked = await asked();
    expect({
      unprompted,
      twice,
      clicked,
      went: state.went.length,
    }).toStrictEqual({
      unprompted: "went",
      twice: "screen.navigation_cancelled",
      clicked: "went",
      went: 2,
    });
  });

  it("replaces the frame's own entry when asked, while the page is still on it", async () => {
    const { state, asked } = pageAt();
    await asked(true);
    expect(state.went).toStrictEqual([{ replace: true }]);
  });
});
