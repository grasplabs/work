// @vitest-environment happy-dom
import {
  companyToolClasses,
  defaultToolClassAudiences,
} from "@grasp-os/shared/connect";
import type {
  CompanyToolClass,
  ToolClassAudience,
  ToolClassSetting,
} from "@grasp-os/shared/connect";
import type {
  AppClassAudience,
  PlaceAudience,
  StephenReach,
} from "@grasp-os/shared/stephen-reach";
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

import { StephenSettings } from "./stephen-settings.tsx";

// Settings › Stephen against core's connections API as the page reaches it
// over RPC (the boundary from the web app), faked: it keeps what an admin
// changes and answers the page's next read with it, so what the page shows
// after a change is what core holds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const sales = { teamId: "team-sales", name: "Sales" };
const support = { teamId: "team-support", name: "Support" };

/** Core's settings, kept as an admin changes them, and each change asked. */
const fakeConnections = () => {
  const asked: unknown[][] = [];
  let reach: StephenReach = {
    on: true,
    audience: { who: "everyone" },
    changedBy: null,
    changedAt: null,
    places: [
      {
        place: "teams",
        audience: { who: "asStephen" },
        acts: true,
        changedBy: null,
        changedAt: null,
      },
    ],
    apps: [
      {
        app: "microsoft",
        classes: (["read-company", "change-own"] as const).map((toolClass) => ({
          toolClass,
          audience: { who: "asClass" },
          changedBy: null,
          changedAt: null,
        })),
      },
    ],
    teams: [sales, support],
  };
  const classes = new Map<CompanyToolClass, ToolClassAudience>(
    companyToolClasses.map((toolClass) => [
      toolClass,
      defaultToolClassAudiences[toolClass],
    ])
  );
  const connections = {
    stephenReach: async (): Promise<StephenReach> => {
      await Promise.resolve();
      return reach;
    },
    toolClasses: async (): Promise<ToolClassSetting[]> => {
      await Promise.resolve();
      return [...classes].map(([toolClass, audience]) => ({
        toolClass,
        audience,
        changedBy: null,
        changedAt: null,
      }));
    },
    setStephenReach: async (on: boolean, audience: ToolClassAudience) => {
      await Promise.resolve();
      asked.push(["reach", on, audience]);
      reach = { ...reach, on, audience };
    },
    setStephenPlace: async (
      place: string,
      audience: PlaceAudience,
      acts: boolean
    ) => {
      await Promise.resolve();
      asked.push(["place", place, audience, acts]);
      reach = {
        ...reach,
        places: reach.places.map((one) =>
          one.place === place ? { ...one, audience, acts } : one
        ),
      };
    },
    setToolClass: async (
      toolClass: CompanyToolClass,
      audience: ToolClassAudience
    ) => {
      await Promise.resolve();
      asked.push(["class", toolClass, audience]);
      classes.set(toolClass, audience);
    },
    setAppToolClass: async (
      app: string,
      toolClass: CompanyToolClass,
      audience: AppClassAudience
    ) => {
      await Promise.resolve();
      asked.push(["app", app, toolClass, audience]);
      reach = {
        ...reach,
        apps: reach.apps.map((one) =>
          one.app === app
            ? {
                ...one,
                classes: one.classes.map((each) =>
                  each.toolClass === toolClass ? { ...each, audience } : each
                ),
              }
            : one
        ),
      };
    },
  };
  return { connections, asked };
};

let root: Root | undefined;

/** The page on the settings its route read. */
const Page = ({
  data,
  editable = true,
}: {
  data: { reach: StephenReach; classes: ToolClassSetting[] };
  editable?: boolean;
}) => (
  <StephenSettings
    classes={data.classes}
    editable={editable}
    reach={data.reach}
  />
);

/** The page on what `connections` holds, for the company's admin when `editable`. */
const shown = async (
  connections: ReturnType<typeof fakeConnections>["connections"],
  editable = true
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const load = async (): Promise<{
    reach: StephenReach;
    classes: ToolClassSetting[];
  }> => ({
    reach: await connections.stephenReach(),
    classes: await connections.toolClasses(),
  });
  const rootRoute = createRootRoute({
    loader: load,
    component: () => (
      <Page data={rootRoute.useLoaderData()} editable={editable} />
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

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The choice labelled `label`. */
const choice = (label: string): HTMLSelectElement => {
  const found = document.querySelector(`select[aria-label="${label}"]`);
  if (!(found instanceof HTMLSelectElement)) {
    throw new TypeError(`No choice ${label}`);
  }
  return found;
};

/** Chooses `value` in `select`, as React hears a person choose it. */
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(select) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      select,
      value
    );
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

/** Ticks the team named `team` among those for `label`. */
const tick = async (label: string, team: string) => {
  const list = document.querySelector(`ul[aria-label="Teams for ${label}"]`);
  const box = [...(list?.querySelectorAll("label") ?? [])]
    .find((each) => each.textContent?.trim() === team)
    ?.querySelector('[role="checkbox"]');
  if (!(box instanceof HTMLElement)) {
    throw new TypeError(`No team ${team} for ${label}`);
  }
  await act(async () => {
    box.click();
    await Promise.resolve();
  });
  await settled();
};

/** The switch named `name`, by its label or the label around it. */
const toggle = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll('[role="switch"]')].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.closest("label")?.textContent?.trim() === name
  );
  if (!(found instanceof HTMLElement)) {
    throw new TypeError(`No switch ${name}`);
  }
  return found;
};

const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The button named `name`. */
const button = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent?.trim().startsWith(name)
  );
  if (!(found instanceof HTMLElement)) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

describe("Settings › Stephen", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("lets an admin say who can talk to him, pause him after asking, and narrow who reaches him in Teams and whether he acts there", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections);

    await choose(choice("Who can talk to him"), "teams");
    // Nothing is saved until a team is chosen.
    const beforeTeam = [...asked];
    await tick("Who can talk to him", "Sales");
    await tick("Who can talk to him", "Support");
    // Teams' panel, opened from its row.
    await press(button("Microsoft Teams"));
    await choose(choice("Who reaches him in Microsoft Teams"), "nobody");
    await press(toggle("Does things for people in Microsoft Teams"));
    // Pausing him asks first.
    await press(toggle("Stephen outside Grasp"));
    const beforePause = asked.length;
    await press(button("Pause"));

    expect({ beforeTeam, beforePause, asked }).toStrictEqual({
      beforeTeam: [],
      beforePause: 4,
      asked: [
        ["reach", true, { who: "teams", teams: [sales.teamId] }],
        [
          "reach",
          true,
          { who: "teams", teams: [sales.teamId, support.teamId] },
        ],
        ["place", "teams", { who: "nobody" }, true],
        ["place", "teams", { who: "nobody" }, false],
        [
          "reach",
          false,
          { who: "teams", teams: [sales.teamId, support.teamId] },
        ],
      ],
    });
    // What the page shows is what core now holds.
    expect({
      who: choice("Who can talk to him").value,
      teams: choice("Who reaches him in Microsoft Teams").value,
      on: toggle("Stephen outside Grasp").getAttribute("aria-checked"),
    }).toStrictEqual({ who: "teams", teams: "nobody", on: "false" });
  });

  it("lets an admin turn a class on for a team, and narrow it for one app, leaving nobody when the last team goes", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections);

    await choose(choice("Reach others"), "teams");
    await tick("Reach others", "Support");
    await press(button("Microsoft 365"));
    await choose(choice("Read the company's in Microsoft 365"), "teams");
    await tick("Read the company's in Microsoft 365", "Sales");
    await tick("Read the company's in Microsoft 365", "Sales");
    await choose(choice("Change their own in Microsoft 365"), "same");

    expect(asked).toStrictEqual([
      ["class", "reach-others", { who: "teams", teams: [support.teamId] }],
      [
        "app",
        "microsoft",
        "read-company",
        { who: "teams", teams: [sales.teamId] },
      ],
      ["app", "microsoft", "read-company", { who: "nobody" }],
      ["app", "microsoft", "change-own", { who: "asClass" }],
    ]);
  });

  it("shows Grasp staff every setting, with nothing they can change", async () => {
    const { connections } = fakeConnections();
    await shown(connections, false);
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        'select, [role="switch"], [role="checkbox"]'
      ),
    ];
    expect({
      shown: controls.length,
      enabled: controls.filter(
        (control) =>
          !(
            (control instanceof HTMLSelectElement && control.disabled) ||
            Object.hasOwn(control.dataset, "disabled") ||
            control.getAttribute("aria-disabled") === "true"
          )
      ).length,
    }).toStrictEqual({
      // Stephen's on and who, and six classes; a place's and an app's
      // panels open from their rows.
      shown: 8,
      enabled: 0,
    });
  });
});
