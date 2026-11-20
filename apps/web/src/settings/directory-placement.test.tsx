// @vitest-environment happy-dom
import type {
  DirectoryPlacement,
  OrganizationTeam,
} from "@grasp-os/shared/members";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DirectoryPlacementSections } from "./directory-placement.tsx";

// Settings › Members › Teams, the departments the directory's read places
// nobody from (GRA-2247), as core's placement answers them: listed with
// how many people each holds whether or not a team can take them, and
// offered for linking only to a team that doesn't follow groups.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const grouped: OrganizationTeam = {
  id: "team-grouped",
  name: "Engineering",
  memberIds: [],
};

/** Core's placement with one department that fills no team. */
const placement: DirectoryPlacement = {
  unplaced: [],
  movers: [],
  pins: [],
  departmentLinks: [],
  unlinkedDepartments: [{ department: "Sales EMEA", people: 3 }],
  teamsFollowingGroups: [grouped.id],
};

/** The sections on `placement`, with the organization's `teams`. */
const shown = async (teams: OrganizationTeam[]): Promise<void> => {
  const core = {
    withSession: async (): Promise<never> =>
      await Promise.reject(new Error("Nothing is changed here")),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <DirectoryPlacementSections
        onChanged={async () => {
          await Promise.resolve();
        }}
        placement={placement}
        teams={teams}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
};

const text = (): string => document.body.textContent ?? "";

const linkButton = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === "Link department"
  );

const firstTeamNote =
  "Make a team that doesn’t follow the directory’s groups first: only such a team can take a department.";

describe("Settings › Members › Teams, departments no team is linked to", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lists them with their people and says to make a team first, with no link, while every team follows groups or there is none", async () => {
    await shown([grouped]);
    const followingOnly = {
      department: text().includes("Sales EMEA"),
      people: text().includes("3 people in the directory"),
      note: text().includes(firstTeamNote),
      link: linkButton(),
    };
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    await shown([]);

    expect({
      followingOnly,
      none: {
        department: text().includes("Sales EMEA"),
        note: text().includes(firstTeamNote),
        link: linkButton(),
      },
    }).toStrictEqual({
      followingOnly: {
        department: true,
        people: true,
        note: true,
        link: undefined,
      },
      none: { department: true, note: true, link: undefined },
    });
  });

  it("offers the link once a team that doesn't follow groups exists", async () => {
    await shown([grouped, { id: "team-sales", name: "Sales", memberIds: [] }]);

    expect({
      link: linkButton() === undefined ? "none" : "offered",
      note: text().includes(firstTeamNote),
    }).toStrictEqual({ link: "offered", note: false });
  });
});
