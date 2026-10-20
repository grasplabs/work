import { screenErrors } from "@grasp-os/shared/screens";
import type { ScreenTarget } from "@grasp-os/shared/screens";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { z } from "zod";

import { useAppPanel } from "./app-panel-context.tsx";
import type { ScreenNavigate } from "./screen-frame.tsx";

// Where a screen's navigation takes the page (spec 10.7.7, 34.1): an App's
// screen, in the same layout the navigating screen runs in; or, for a
// surface, where the host places it: the shell's panel, or the App's
// settings tab.
//
// The route, input and surface core resolved go in the history entry's
// state, never in the address: anyone can write an address, and a link
// that opens a screen with input of the link's choosing would let it act
// as the person's own navigation. The page alone writes history state, and
// only with what core resolved (a screen's navigation, a sidebar entry, a
// deep link core checked as one). An address without that state, pasted
// or followed, opens the screen with its default input only. Opening the
// screen checks route, surface and input with core again either way.

/** How the page opens a screen: what core resolved, kept in history state. */
export const screenOpeningSchema = z.object({
  app: z.string().max(64),
  screen: z.string().max(64),
  route: z.string().max(64),
  /** The input, as JSON text. */
  input: z.string().max(8192),
  surface: z.string().max(64).optional(),
  /** When a navigation to the App's settings asked for it. */
  requestedAt: z.number().optional(),
});
export type ScreenOpening = z.infer<typeof screenOpeningSchema>;

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The screen this entry opens, as core resolved it (screen-navigate.ts). */
    screenOpening?: ScreenOpening;
  }
}

/**
 * The opening this history entry holds for `screen` of `app`, if it holds
 * one for that screen: none for an address opened any other way.
 */
export const useScreenOpening = (
  app: string,
  screen: string
): ScreenOpening | undefined => {
  const state: unknown = useRouterState({
    select: ({ location }) => location.state.screenOpening,
  });
  const opening = screenOpeningSchema.safeParse(state);
  return opening.success &&
    opening.data.app === app &&
    opening.data.screen === screen
    ? opening.data
    : undefined;
};

/** The history state that opens `target` of `app`. */
export const openingState = (
  app: string,
  target: {
    screen: string;
    route: string;
    input: ScreenTarget["input"];
    surface?: string;
    requestedAt?: number;
  }
): { screenOpening: ScreenOpening } => ({
  screenOpening: {
    app,
    screen: target.screen,
    route: target.route,
    input: JSON.stringify(target.input),
    ...(target.surface === undefined ? {} : { surface: target.surface }),
    ...(target.requestedAt === undefined
      ? {}
      : { requestedAt: target.requestedAt }),
  },
});

/** The layouts a screen runs in: in Grasp's frame, or full page. */
type ScreenLayout =
  | "/domains/$engine/apps/$screen"
  | "/domains/$engine/apps/$screen/full";

/**
 * How a screen of `app` running in `layout` navigates the page: to the
 * screen core resolved, in that layout, pushing an entry or replacing the
 * current one, or to the place its surface goes. Resolves once the page
 * went there; refused (`screen.navigation_cancelled`) when the person
 * stayed on a screen with unsaved edits instead.
 */
export const useScreenNavigate = (
  app: string,
  layout: ScreenLayout
): ScreenNavigate => {
  const router = useRouter();
  const panel = useAppPanel();
  return async (target: ScreenTarget, replace: boolean) => {
    const { surface } = target;
    // Outside the shell (a full page) no slot stands: it opens as a route.
    if (surface?.kind === "panel" && panel !== null) {
      // Beside the page, which stays where it is; refused as a route is
      // when the person stays with the edits of the screen the panel shows.
      const opened = await panel.open({
        app,
        screen: target.screen,
        title: surface.title,
        route: target.route,
        input: JSON.stringify(target.input),
        surface: surface.name,
      });
      if (!opened) {
        throw screenErrors.create("screen.navigation_cancelled");
      }
      return;
    }
    const settings = surface?.kind === "settings";
    // The settings tab opens its screen with this input too. Each asking
    // for it is an entry of its own (`requestedAt`), so the tab shows
    // whichever tab the person had chosen since.
    const opening = openingState(app, {
      screen: target.screen,
      route: target.route,
      input: target.input,
      ...(surface === undefined ? {} : { surface: surface.name }),
      ...(settings ? { requestedAt: Date.now() } : {}),
    });
    const { href } = settings
      ? router.buildLocation({
          to: "/domains/$engine",
          params: { engine: app },
          search: { tab: "settings" },
        })
      : router.buildLocation({
          to: layout,
          params: { engine: app, screen: target.screen },
        });
    // Already there, as it opens: the router commits nothing new, and that
    // is no refusal.
    const here = router.state.location;
    const already =
      here.href === href &&
      JSON.stringify(here.state.screenOpening) ===
        JSON.stringify(opening.screenOpening);
    // Each entry has a key of its own: one that didn't change, for a page
    // not already there, is a page that didn't go (the person stayed).
    const before = here.state.__TSR_key;
    await router.navigate({
      href,
      state: opening,
      replace: replace && !settings,
    });
    if (!already && router.state.location.state.__TSR_key === before) {
      throw screenErrors.create("screen.navigation_cancelled");
    }
  };
};

/**
 * How a screen of `app` outside a route (the shell's panel, the chat's)
 * navigates: in the main pane, in Grasp's frame, always as a new entry, so
 * the page it leaves is never replaced.
 */
export const usePushNavigate = (app: string): ScreenNavigate => {
  const navigate = useScreenNavigate(app, "/domains/$engine/apps/$screen");
  return async (target) => {
    await navigate(target, false);
  };
};
