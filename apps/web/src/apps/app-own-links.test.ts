import { appLinkSchema, reservedAppLinks } from "@grasp-os/shared/apps";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { CoreConnection } from "../core-connection.ts";
import { routeTree } from "../routeTree.gen.ts";
import { suggestedLink } from "./app-own-link.tsx";

// An App's link is tried only where no page is (`routes/_shell.$.tsx`), and
// shared's `reservedAppLinks` keeps links off every page's first part, so a
// page added later can't be taken by a link set before it. Asked of the
// app's own router, which knows every page.

const router = createRouter({
  routeTree,
  history: createMemoryHistory(),
  // Matching an address reaches no core: one that is never connected.
  context: {
    core: new CoreConnection({
      onSessionEnded: () => {
        // Nobody signs in here.
      },
    }),
  },
});

/** The route the router opens for `path`: the deepest it matches. */
const routeAt = (path: string): string | undefined =>
  router.matchRoutes(path).at(-1)?.routeId;

/** Where the router tries an App's link. */
const appLinkRoute = "/_shell/$";

describe("App links", () => {
  it("are kept off the first part of every page's address", () => {
    const parts = new Set(
      Object.keys(router.routesByPath)
        .map((path) => path.split("/")[1] ?? "")
        .filter((part) => part !== "" && !part.startsWith("$"))
    );

    expect({
      read: parts.size > 10,
      unreserved: [...parts].filter((part) => !reservedAppLinks.has(part)),
    }).toStrictEqual({ read: true, unreserved: [] });
  });

  it("are suggested from an App's name, in a form core takes, and open the App where no page is", () => {
    const suggested = [
      "Sales pipeline",
      "  Ärger & Co. — Q3!  ",
      "x".repeat(80),
    ].map(suggestedLink);

    expect({
      suggested: suggested.slice(0, 2),
      valid: suggested.map((link) => appLinkSchema.safeParse(link).success),
      opened: suggested.map((link) => routeAt(`/${link}`)),
    }).toStrictEqual({
      suggested: ["sales-pipeline", "arger-co-q3"],
      valid: [true, true, true],
      opened: [appLinkRoute, appLinkRoute, appLinkRoute],
    });
  });
});
