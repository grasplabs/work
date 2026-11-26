import { createFileRoute } from "@tanstack/react-router";

import { NotFound } from "../admin/failure.tsx";

/**
 * Every address no other page has, said so in the admin's frame. A route
 * of its own, not the router's not-found: an address the router can't
 * match is not found at the root itself, so the Worker's document marks
 * the root's match as done without running its loader (server rendering
 * is off), and the frame, which needs that loader's records, could not be
 * drawn ("The admin couldn't be read"). Matched here, the root loads as
 * on any page.
 */
export const Route = createFileRoute("/$")({
  head: () => ({ meta: [{ title: "Not found" }] }),
  component: NotFound,
});
