// @vitest-environment happy-dom
import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route } from "../routes/_shell.settings.brain.tsx";

// Settings › Brain, the brain's groups of teams, is an admin's: anyone else
// who follows a link to it goes to their own Profile, as Teams and
// Incoming events send them, rather than to a page they can't use. Core
// refuses their save all the same (core's brain-team-groups.test.ts).

/** The page's guard, as the router calls it: with the person in its context. */
// SAFETY: the guard reads only the person's role from the route's context.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const guard = Route.options.beforeLoad as (match: {
  context: { identity: { role: string; staff: boolean } };
}) => void;

/** Where the page sends someone of `role`: Profile, or nowhere (it opens). */
const sentTo = (role: "admin" | "builder" | "user", staff = false): unknown => {
  try {
    guard({ context: { identity: { role, staff } } });
    return null;
  } catch (error) {
    return isRedirect(error) ? error.options.to : error;
  }
};

describe("Settings › Brain", () => {
  it("opens for an admin, Grasp staff signed in as one too, and sends anyone else to Profile", () => {
    expect({
      admin: sentTo("admin"),
      staff: sentTo("admin", true),
      builder: sentTo("builder"),
      member: sentTo("user"),
    }).toStrictEqual({
      admin: null,
      staff: null,
      builder: "/settings/profile",
      member: "/settings/profile",
    });
  });
});
