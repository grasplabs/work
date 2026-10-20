import { screenErrors } from "@grasp-os/shared/screens";
import { useRouter } from "@tanstack/react-router";
import { z } from "zod";

import type { ScreenNavigate } from "./screen-frame.tsx";

// Where a screen's navigation takes the page (spec 10.7.7): an App's
// screen route, in the same layout the navigating screen runs in, with the
// route and input core resolved carried in the address. The address is
// the page's own: what a screen asks for never becomes one, and opening
// the screen checks the route and input with core again.

/** What a screen's address carries besides its App and file. */
export const screenSearchSchema = z.object({
  route: z.string().max(64).optional(),
  input: z.string().optional(),
});

/** The layouts a screen runs in: in Grasp's frame, or full page. */
type ScreenLayout =
  | "/domains/$engine/apps/$screen"
  | "/domains/$engine/apps/$screen/full";

/**
 * How a screen of `app` running in `layout` navigates the page: to the
 * screen core resolved, in that layout, pushing an entry or replacing the
 * current one. Resolves once the page went there; refused
 * (`screen.navigation_cancelled`) when the person stayed on a screen with
 * unsaved edits instead.
 */
export const useScreenNavigate = (
  app: string,
  layout: ScreenLayout
): ScreenNavigate => {
  const router = useRouter();
  return async (target, replace) => {
    const options = {
      to: layout,
      params: { engine: app, screen: target.screen },
      search: { route: target.route, input: JSON.stringify(target.input) },
    };
    const { href } = router.buildLocation(options);
    await router.navigate({ ...options, replace });
    if (router.state.location.href !== href) {
      throw screenErrors.create("screen.navigation_cancelled");
    }
  };
};
