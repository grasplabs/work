// @vitest-environment happy-dom
import type { Agent, AgentInput, AgentSettings } from "@grasp-os/shared/agents";
import { companyToolClasses } from "@grasp-os/shared/connect";
import type {
  CompanyToolClass,
  ToolClassAudience,
} from "@grasp-os/shared/connect";
import type { AppClassAudience } from "@grasp-os/shared/stephen-reach";
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

import { AgentsSettings } from "./agents-settings.tsx";

// Settings › Agents against core's connections API as the page reaches it
// over RPC (the boundary from the web app), faked: it keeps what an admin
// makes and changes and answers the page's next read with it, so what the
// page shows after a change is what core holds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const sales = { teamId: "team-sales", name: "Sales" };
const teams = [sales, { teamId: "team-support", name: "Support" }];

const stephen: Agent = {
  id: "organization",
  name: "Stephen",
  face: "stephen",
  job: "Answers from what the company told Grasp.",
  instructions: "",
  modelRole: null,
  state: "on",
  changedBy: null,
  changedAt: null,
};

/** Core's agents, kept as an admin makes and changes them, and each change asked. */
const fakeConnections = () => {
  const asked: unknown[][] = [];
  let agents: Agent[] = [stephen];
  const settings = new Map<string, AgentSettings>();
  const changed = (id: string, change: Partial<Agent>): void => {
    agents = agents.map((agent) =>
      agent.id === id
        ? { ...agent, ...change, changedAt: `${asked.length}` }
        : agent
    );
  };
  const connections = {
    agents: async (): Promise<Agent[]> => {
      await Promise.resolve();
      return agents;
    },
    agentSettings: async (id: string): Promise<AgentSettings> => {
      await Promise.resolve();
      const found = settings.get(id);
      if (found === undefined) {
        throw new Error("No such agent");
      }
      return found;
    },
    makeAgent: async (input: AgentInput): Promise<Agent> => {
      await Promise.resolve();
      asked.push(["make", input]);
      const made: Agent = {
        id: `agent-${agents.length}`,
        ...input,
        state: "on",
        changedBy: "admin",
        changedAt: "made",
      };
      agents = [...agents, made];
      // As core makes it: reaching nobody, every class for nobody.
      settings.set(made.id, {
        on: true,
        audience: { who: "nobody" },
        classes: companyToolClasses.map((toolClass) => ({
          toolClass,
          audience: { who: "nobody" },
        })),
      });
      return made;
    },
    changeAgent: async (id: string, input: AgentInput) => {
      await Promise.resolve();
      asked.push(["change", id, input]);
      changed(id, input);
    },
    setAgentPaused: async (id: string, paused: boolean) => {
      await Promise.resolve();
      asked.push(["paused", id, paused]);
      changed(id, { state: paused ? "paused" : "on" });
    },
    setAgentReach: async (
      id: string,
      on: boolean,
      audience: ToolClassAudience
    ) => {
      await Promise.resolve();
      asked.push(["reach", id, on, audience]);
      const found = settings.get(id);
      if (found !== undefined) {
        settings.set(id, { ...found, on, audience });
      }
    },
    setAgentToolClass: async (
      id: string,
      toolClass: CompanyToolClass,
      audience: AppClassAudience
    ) => {
      await Promise.resolve();
      asked.push(["class", id, toolClass, audience]);
      const found = settings.get(id);
      if (found !== undefined) {
        settings.set(id, {
          ...found,
          classes: found.classes.map((each) =>
            each.toolClass === toolClass ? { ...each, audience } : each
          ),
        });
      }
    },
  };
  return { connections, asked };
};

type Connections = ReturnType<typeof fakeConnections>["connections"];

let root: Root | undefined;

/** What the page's route read. */
interface Shown {
  agents: Agent[];
  settings: Record<string, AgentSettings>;
}

/** The page on the agents its route read. */
const Page = ({ data, editable }: { data: Shown; editable: boolean }) => (
  <AgentsSettings
    agents={data.agents}
    editable={editable}
    settings={data.settings}
    teams={teams}
  />
);

/** The page on what `connections` holds, for the company's admin when `editable`. */
const shown = async (connections: Connections, editable = true) => {
  const core = {
    withSession: async <T,>(
      action: (session: { connections: Connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const load = async (): Promise<Shown> => {
    const agents = await connections.agents();
    const read = await Promise.all(
      agents
        .slice(1)
        .map(async ({ id }): Promise<[string, AgentSettings]> => [
          id,
          await connections.agentSettings(id),
        ])
    );
    return { agents, settings: Object.fromEntries(read) };
  };
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

const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The button named `name`, or one whose words start with it. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent?.trim().startsWith(name)
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

/** The field labelled `label`. */
const field = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const named = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  const found = document.querySelector(`#${CSS.escape(named?.htmlFor ?? "")}`);
  if (
    !(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)
  ) {
    throw new TypeError(`No field ${label}`);
  }
  return found;
};

/** Sets `element`'s value, as React hears a person type or choose it. */
const set = async (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  event: "input" | "change"
) => {
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(element) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new Event(event, { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

/** The choice labelled `label`, or none. */
const choice = (label: string): HTMLSelectElement | null => {
  const found = document.querySelector(`select[aria-label="${label}"]`);
  return found instanceof HTMLSelectElement ? found : null;
};

/** The switch labelled `name`. */
const toggle = (name: string): HTMLElement => {
  const found = document.querySelector(`[role="switch"][aria-label="${name}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new TypeError(`No switch ${name}`);
  }
  return found;
};

/** Makes an agent named Claire through the page, and leaves it open. */
const madeClaire = async () => {
  await press(button("New agent"));
  await set(field("Name"), " Claire ", "input");
  await set(field("What it is for"), "Chases unpaid invoices.", "input");
  await set(field("Instructions"), "Answer only about invoices.", "input");
  await press(button("Make agent"));
};

describe("Settings › Agents", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lists the agents, and leads to Settings › Stephen for the first one's reach", async () => {
    const { connections } = fakeConnections();
    await shown(connections);
    expect(document.body.textContent).toContain("Stephen");
    expect(document.body.textContent).toContain(
      "Answers from what the company told Grasp."
    );
    await press(button("Stephen"));
    // Its own reach and classes aren't set here.
    expect(choice("Who may use Stephen")).toBeNull();
    expect(document.body.textContent).toContain("Open its settings");
  });

  it("makes an agent from what an admin types, and opens it reaching nobody", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections);
    await madeClaire();
    expect(asked).toStrictEqual([
      [
        "make",
        {
          name: "Claire",
          job: "Chases unpaid invoices.",
          instructions: "Answer only about invoices.",
          face: "stephen",
          modelRole: null,
        },
      ],
    ]);
    expect(choice("Who may use Claire")?.value).toBe("nobody");
    expect(choice("Read their own, for Claire")?.value).toBe("nobody");
  });

  it("saves whom an agent answers and what it may do as an admin chooses them", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections);
    await madeClaire();
    const who = choice("Who may use Claire");
    const readOwn = choice("Read their own, for Claire");
    if (who === null || readOwn === null) {
      throw new TypeError("Expected Claire's choices");
    }
    await set(who, "everyone", "change");
    await set(readOwn, "same", "change");
    expect(asked.slice(1)).toStrictEqual([
      ["reach", "agent-1", true, { who: "everyone" }],
      ["class", "agent-1", "read-own", { who: "asClass" }],
    ]);
    // Read again from core: the page shows what it keeps.
    expect(choice("Who may use Claire")?.value).toBe("everyone");
    expect(choice("Read their own, for Claire")?.value).toBe("same");
  });

  it("changes an agent's name and pauses it, and says so in the list", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections);
    await madeClaire();
    await set(field("Name"), "Clara", "input");
    await press(button("Save"));
    await press(toggle("Clara is on"));
    expect(asked.slice(1)).toStrictEqual([
      [
        "change",
        "agent-1",
        {
          name: "Clara",
          job: "Chases unpaid invoices.",
          instructions: "Answer only about invoices.",
          face: "stephen",
          modelRole: null,
        },
      ],
      ["paused", "agent-1", true],
    ]);
    expect(document.body.textContent).toContain("Paused · answers nobody");
  });

  it("offers someone who isn't the company's admin nothing to change", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections, false);
    expect(
      [...document.querySelectorAll("button")].some(
        (each) => each.textContent?.trim() === "New agent"
      )
    ).toBeFalsy();
    await press(button("Stephen"));
    expect(field("Name").disabled).toBeTruthy();
    expect(button("Save").disabled).toBeTruthy();
    expect(asked).toStrictEqual([]);
  });
});
