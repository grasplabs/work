import { createLink } from "@tanstack/react-router";

import { Link } from "../grasp/link/index.ts";

/**
 * Grasp UI's Link as a link the router follows within Grasp: its look, and
 * the router's `to`, `params` and `search`. Grasp UI's Link takes an
 * `href` alone, with no way to hand it a router's link.
 */
export const RouterLink = createLink(Link);
