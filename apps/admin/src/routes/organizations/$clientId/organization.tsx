import { createFileRoute, redirect } from "@tanstack/react-router";

interface OrganizationSearch {
  /** The team that was open. */
  team?: string;
}

/**
 * The company's teams are where its interviews are, on the Teams tab of
 * Interviews: its old address goes there, its open team with it.
 */
export const Route = createFileRoute("/organizations/$clientId/organization")({
  // An id of digits comes parsed as a number.
  validateSearch: (search: Record<string, unknown>): OrganizationSearch => {
    const { team } = search;
    if (typeof team === "number") {
      return { team: String(team) };
    }
    return typeof team === "string" && team !== "" ? { team } : {};
  },
  beforeLoad: ({ params, search }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect is thrown, as it documents
    throw redirect({
      to: "/organizations/$clientId/interviews",
      params,
      search,
    });
  },
});
