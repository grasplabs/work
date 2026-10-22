import { screenErrors } from "@grasp-os/shared/screens";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { PageError, PageLoading } from "../frame/page-states.tsx";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import { openingState } from "../screens/screen-navigate.ts";

// Where an App's deep link leads (spec 34.1): `/links/<app>/<surface>`,
// with the surface's input as JSON text in `input`. Anyone can write one,
// so it opens nothing on its own: the shell has the person signed in
// first (coming back here with the input), then core checks that the App
// declares that deep link, that the person may open it now and that the
// input is the surface's, before the page goes to the screen, in place of
// this address. Refused, the page says so and the screen never runs: no
// input reaches it.

/**
 * The input a link carries: the router reads `input` as JSON already when
 * it is; text it couldn't read is read again here, and what still isn't
 * JSON is `null`, which core refuses. Core bounds and checks it all.
 */
const linkInput = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const DeepLink = () => {
  const refused = Route.useLoaderData();
  const { i18n, t } = useLingui();
  return (
    <PageError
      reason={notLoadedText(refused, i18n)}
      title={t`This link doesn't open anything you can open`}
    />
  );
};

export const Route = createFileRoute("/_shell/links/$app/$surface")({
  pendingComponent: PageLoading,
  component: DeepLink,
  validateSearch: z.object({ input: z.unknown().optional() }),
  loaderDeps: ({ search }) => ({ input: search.input }),
  loader: async ({ context: { core }, params, deps }) => {
    const resolved = await loadFromCore(core, async (session) => {
      const surfaces = await session.screens.surfaces(params.app);
      // Only a surface the App declares as a deep link opens from one.
      const surface = surfaces.find(
        ({ name, kind }) => name === params.surface && kind === "deepLink"
      );
      if (surface === undefined) {
        throw screenErrors.create("screen.not_found");
      }
      // Core checks it is one the App declares as a deep link.
      return await session.screens.navigate(params.app, {
        route: surface.route,
        input: linkInput(deps.input),
        surface: surface.name,
        deepLink: true,
      });
    });
    if (resolved.state !== "ready") {
      return resolved;
    }
    const target = resolved.data;
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/domains/$engine/apps/$screen",
      params: { engine: params.app, screen: target.screen },
      // What core resolved, in the entry's state: never the link's address.
      state: openingState(params.app, {
        screen: target.screen,
        route: target.route,
        input: target.input,
        ...(target.surface === undefined
          ? {}
          : { surface: target.surface.name }),
      }),
      replace: true,
    });
  },
});
