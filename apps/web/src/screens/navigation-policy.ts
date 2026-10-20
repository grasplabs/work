import { screenErrors } from "@grasp-os/shared/screens";
import type { ScreenTarget } from "@grasp-os/shared/screens";

// What a screen's navigation may do to the page, for one start of its frame
// (spec 10.7.7). The person's own moves always win over an App's:
//
// - The page goes nowhere once it left the page the frame started on, or
//   is on its way elsewhere: a late answer never undoes the person's own
//   click. So `replace` only ever replaces the frame's own entry. A frame
//   beside the page (the shell's panel) outlives the page's navigations:
//   it only waits out one under way.
// - Once the person chose to stay on a screen with unsaved edits, its
//   further navigations are refused without asking again, until its edits
//   are gone or a short while passed: an App can't hold the person in a
//   loop of the same question.
// - Without the person's activation (a click, a key), the page goes at most
//   once on a screen's word, across every start in the tab (`TabBudget`):
//   each start would otherwise get its own go, so a screen that navigates
//   as it mounts could open the next start that does the same, filling the
//   history, and send the person forward again each time they went Back.
//   A navigation while the person acts gives the tab its go back. Beside
//   the page, never: there only the person's act in the frame itself counts.

/** How the page goes to a target, pushing or replacing its entry. */
export type PageNavigate = (
  target: ScreenTarget,
  replace: boolean
) => Promise<void>;

/** What the policy reads of the page and the time. */
export interface PageState {
  /** Where the page is, and where it is going (the same when settled). */
  location: () => { here: string; going: string };
  /** Whether the person just acted (transient user activation). */
  activated: () => boolean;
  now: () => number;
}

/** How long a screen's navigations are refused after the person stayed. */
export const stayCooldownMs = 10_000;

/** One frame start's navigations, and what its leave guard says. */
export interface NavigationPolicy {
  navigate: PageNavigate;
  guardChanged: (guarded: boolean) => void;
  /**
   * The person chose to stay in the leave dialog: the navigation waiting
   * on it is refused (`screen.navigation_cancelled`), and so are the next
   * ones for a while (see the header).
   */
  stayed: () => void;
}

/** The tab's one navigation without the person acting, shared by its starts. */
export interface TabBudget {
  /** Takes the tab's go, if it still has it. */
  take: () => boolean;
  /** The person acted: the tab may go once more on its own. */
  restore: () => void;
}

/** A tab's budget, with its go. */
export const tabBudget = (): TabBudget => {
  let spent = false;
  return {
    take: () => {
      if (spent) {
        return false;
      }
      spent = true;
      return true;
    },
    restore: () => {
      spent = false;
    },
  };
};

const cancelled = (): Error =>
  screenErrors.create("screen.navigation_cancelled");

/** The policy for one frame start, on the page it started on, in its tab. */
export const navigationPolicy = (
  go: PageNavigate,
  page: PageState,
  tab: TabBudget,
  /**
   * Where the frame runs: on the page it started on (a route's screen),
   * whose navigations end once the page left it; or beside the page (the
   * shell's panel), which outlives the page's own navigations and only
   * waits out one under way.
   */
  placement: "page" | "beside" = "page"
): NavigationPolicy => {
  const { here: start } = page.location();
  let stayedAt: number | undefined;
  /** What refuses each navigation waiting on the leave dialog. */
  const waiting = new Set<(error: Error) => void>();
  return {
    navigate: async (target, replace) => {
      const { here, going } = page.location();
      const left = placement === "page" && here !== start;
      if (left || going !== here) {
        throw cancelled();
      }
      if (stayedAt !== undefined && page.now() - stayedAt < stayCooldownMs) {
        throw cancelled();
      }
      if (page.activated()) {
        tab.restore();
      } else if (placement === "beside" || !tab.take()) {
        // Beside the page, never, and without taking the tab's go: only
        // the person's own act in its frame.
        throw cancelled();
      }
      // The page's own navigation waits while the dialog asks, and may
      // never settle once the person stays: their answer settles it.
      const { promise: onStay, reject } = Promise.withResolvers<never>();
      // Refused only while this one waits (`stayed`), so only ever raced.
      waiting.add(reject);
      try {
        await Promise.race([go(target, replace), onStay]);
      } catch (error) {
        if (screenErrors.codeOf(error) === "screen.navigation_cancelled") {
          stayedAt = page.now();
        }
        throw error;
      } finally {
        waiting.delete(reject);
      }
    },
    stayed: () => {
      stayedAt = page.now();
      for (const reject of waiting) {
        reject(cancelled());
      }
      waiting.clear();
    },
    guardChanged: (guarded) => {
      if (!guarded) {
        stayedAt = undefined;
      }
    },
  };
};
