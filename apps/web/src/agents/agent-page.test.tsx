// @vitest-environment happy-dom
import type {
  Agent,
  AgentInput,
  AgentSettings,
  AgentWake,
  AgentWakeInput,
} from "@grasp-os/shared/agents";
import { companyToolClasses } from "@grasp-os/shared/connect";
import type {
  CompanyToolClass,
  ToolClassAudience,
} from "@grasp-os/shared/connect";
import type { Member } from "@grasp-os/shared/members";
import type { AppClassAudience } from "@grasp-os/shared/stephen-reach";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentPage } from "./agent-page.tsx";
import type { AgentTab } from "./agent-page.tsx";
import { NewAgent } from "./new-agent.tsx";

// One agent's page and the new agent's page against core's connections
// API as they reach it over RPC (the boundary from the web app), faked:
// it keeps what an admin makes and changes and answers the page's next
// read with it, so what a page shows after a change is what core holds.
// These start from the ways the pages can fail: a change that never
// reaches core, or reaches it as something else; what is typed and not
// yet saved lost to a refresh, a refusal or a look at another tab; a
// refusal not said where it was made; someone who isn't the company's
// admin given a way to change an agent.

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
  model: null,
  state: "on",
  changedBy: null,
  changedAt: null,
};

const anna: Member = {
  userId: "user-anna",
  name: "Anna de Vries",
  email: "anna@acme.test",
  role: "user",
  joinedAt: "2026-01-05T09:00:00.000Z",
};
const people = [anna];

/** The models the organization chose. */
const models = ["anthropic/claude-sonnet-4-5"];

/** Core's agents, kept as an admin makes and changes them, and each change asked. */
const fakeConnections = () => {
  const asked: unknown[][] = [];
  let agents: Agent[] = [stephen];
  let wakes: AgentWake[] = [];
  const settings = new Map<string, AgentSettings>();
  const changed = (id: string, change: Partial<Agent>): void => {
    agents = agents.map((agent) =>
      agent.id === id
        ? { ...agent, ...change, changedAt: "2026-11-12T10:00:00.000Z" }
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
      // As core refuses a name another agent has.
      if (agents.some(({ name }) => name === input.name)) {
        throw new Error("Another agent already has that name.");
      }
      const made: Agent = {
        id: `agent-${agents.length}`,
        ...input,
        model: input.model ?? null,
        state: "on",
        changedBy: "admin",
        changedAt: "2026-11-12T09:00:00.000Z",
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
    agentWakes: async (agentId: string): Promise<AgentWake[]> => {
      await Promise.resolve();
      return wakes.filter((wake) => wake.agentId === agentId);
    },
    makeAgentWake: async (
      agentId: string,
      input: AgentWakeInput
    ): Promise<AgentWake> => {
      await Promise.resolve();
      asked.push(["wake", agentId, input]);
      // As core refuses what isn't a wake-up.
      if (input.opening === "refuse this") {
        throw new Error("That isn't a wake-up.");
      }
      const made: AgentWake = {
        id: `wake-${wakes.length + 1}`,
        agentId,
        cron: input.cron,
        timeZone: input.timeZone ?? "Europe/Amsterdam",
        personId: input.personId,
        opening: input.opening,
        state: "on",
        nextAt: "2026-11-12T08:00:00.000Z",
        lastAt: null,
        lastOutcome: null,
      };
      wakes = [...wakes, made];
      return made;
    },
    setAgentWakePaused: async (wakeId: string, paused: boolean) => {
      await Promise.resolve();
      asked.push(["wake paused", wakeId, paused]);
      wakes = wakes.map((wake) =>
        wake.id === wakeId
          ? { ...wake, state: paused ? ("paused" as const) : ("on" as const) }
          : wake
      );
    },
    deleteAgentWake: async (wakeId: string) => {
      await Promise.resolve();
      asked.push(["wake deleted", wakeId]);
      wakes = wakes.filter((wake) => wake.id !== wakeId);
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
  wakes: Record<string, AgentWake[]>;
}

/** What is shown: one agent's page, by its name, or the new agent's. */
type Open = { agent: string; tab?: AgentTab } | "new";

/** The page for `open` on the agents its route read, its tab kept as its route would. */
const Page = ({
  data,
  editable,
  open,
}: {
  data: Shown;
  editable: boolean;
  open: Open;
}) => {
  const [tab, setTab] = useState<AgentTab>(
    open === "new" ? "overview" : (open.tab ?? "overview")
  );
  if (open === "new") {
    return <NewAgent models={models} />;
  }
  const agent = data.agents.find(({ name }) => name === open.agent);
  if (agent === undefined) {
    return <p>No such agent</p>;
  }
  return (
    <AgentPage
      agent={agent}
      editable={editable}
      first={agent.id === data.agents.at(0)?.id}
      models={models}
      onTab={setTab}
      people={people}
      settings={data.settings[agent.id]}
      tab={tab}
      teams={teams}
      usable
      usage={undefined}
      wakes={data.wakes[agent.id] ?? []}
    />
  );
};

/** `open` on what `connections` holds, for the company's admin when `editable`. */
const shown = async (connections: Connections, open: Open, editable = true) => {
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
    const woken = await Promise.all(
      agents.map(async ({ id }): Promise<[string, AgentWake[]]> => [
        id,
        await connections.agentWakes(id),
      ])
    );
    return {
      agents,
      settings: Object.fromEntries(read),
      wakes: Object.fromEntries(woken),
    };
  };
  const rootRoute = createRootRoute({
    loader: load,
    component: () => (
      <Page data={rootRoute.useLoaderData()} editable={editable} open={open} />
    ),
    // Where the new agent's page leads: an address this router has no page for.
    notFoundComponent: () => <p>Elsewhere</p>,
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
  return router;
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

/** Whether `element` is on the open tab, or outside the tabs. */
const inView = (element: Element): boolean =>
  element.closest("[role='tabpanel'][hidden]") === null;

/** The button in view named `name`, or one whose words start with it. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      inView(each) &&
      (each.getAttribute("aria-label") === name ||
        each.textContent?.trim().startsWith(name))
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

/** Opens the tab named `name`. */
const openTab = async (name: string) => {
  const tab = [...document.querySelectorAll("[role='tab']")].find((each) =>
    each.textContent?.trim().startsWith(name)
  );
  if (!(tab instanceof HTMLElement)) {
    throw new TypeError(`No tab ${name}`);
  }
  await press(tab);
};

/** The field labelled `label`, on whichever tab it is. */
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

/** The switch in the page's heading, which turns the agent off and on. */
const onSwitch = (): HTMLElement => {
  const found = document.querySelector("label [role='switch']");
  if (!(found instanceof HTMLElement)) {
    throw new TypeError("No on switch");
  }
  return found;
};

const claire = {
  name: "Claire",
  job: "Chases unpaid invoices.",
  instructions: "Answer only about invoices.",
  face: "stephen",
  model: null,
  modelRole: null,
};

/** Core with an agent named Claire an admin made earlier, and nothing asked since. */
const withClaire = async () => {
  const fake = fakeConnections();
  await fake.connections.makeAgent(claire);
  fake.asked.length = 0;
  return fake;
};

describe("an agent's page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("leads to Settings › Stephen for the first agent's reach, with nothing to choose here", async () => {
    const { connections } = fakeConnections();
    await shown(connections, { agent: "Stephen", tab: "access" });
    expect(choice("Who may use Stephen")).toBeNull();
    expect(
      document.querySelector("a[href='/settings/stephen']")?.textContent
    ).toBe("Open Settings › Stephen");
  });

  it("makes an agent from what an admin types, and leads to its access", async () => {
    const { connections, asked } = fakeConnections();
    const router = await shown(connections, "new");
    await set(field("Name"), " Claire ", "input");
    await set(field("What it is for"), "Chases unpaid invoices.", "input");
    await set(field("Instructions"), "Answer only about invoices.", "input");
    await press(button("Make agent"));
    expect(asked).toStrictEqual([["make", claire]]);
    expect(router.state.location.href).toBe("/agents/agent-1?tab=access");
  });

  it("opens a new agent reaching nobody, and saves whom it answers and what it may do as an admin chooses them", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire", tab: "access" });
    const who = choice("Who may use Claire");
    const readOwn = choice("Read their own, for Claire");
    if (who === null || readOwn === null) {
      throw new TypeError("Expected Claire's choices");
    }
    const before = [who.value, readOwn.value];
    await set(who, "everyone", "change");
    await set(readOwn, "same", "change");
    expect(before).toStrictEqual(["nobody", "nobody"]);
    expect(asked).toStrictEqual([
      ["reach", "agent-1", true, { who: "everyone" }],
      ["class", "agent-1", "read-own", { who: "asClass" }],
    ]);
    // Read again from core: the page shows what it keeps.
    expect(choice("Who may use Claire")?.value).toBe("everyone");
    expect(choice("Read their own, for Claire")?.value).toBe("same");
  });

  it("saves a new name with the rest of the agent as it was", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire" });
    await set(field("Name"), "Clara", "input");
    await press(button("Save"));
    expect(asked).toStrictEqual([
      ["change", "agent-1", { ...claire, name: "Clara" }],
    ]);
  });

  it("pauses an agent from its heading, and says it is paused", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire" });
    await press(onSwitch());
    expect(asked).toStrictEqual([["paused", "agent-1", true]]);
    expect(document.querySelector("h1")?.parentElement?.textContent).toContain(
      "Paused"
    );
    expect(document.body.textContent).toContain("Claire is paused");
  });

  it("offers someone who isn't the company's admin nothing to change", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire" }, false);
    expect({
      name: field("Name").disabled,
      save: button("Save").disabled,
      on:
        Object.hasOwn(onSwitch().dataset, "disabled") ||
        onSwitch().getAttribute("aria-disabled") === "true",
    }).toStrictEqual({ name: true, save: true, on: true });
    await openTab("Schedule");
    expect(document.body.textContent).toContain(
      "Claire never works on its own."
    );
    expect(document.body.textContent).not.toContain("Add a time");
    expect(asked).toStrictEqual([]);
  });

  it("says why an agent wasn't made on the page it was typed on, and keeps what was typed", async () => {
    const { connections } = fakeConnections();
    const router = await shown(connections, "new");
    await set(field("Name"), "Stephen", "input");
    await press(button("Make agent"));
    expect(document.body.textContent).toContain(
      "Another agent already has that name."
    );
    expect(field("Name").value).toBe("Stephen");
    expect(router.state.location.href).toBe("/");
  });

  it("keeps what is typed and not yet saved while the agent is paused, and while another tab is looked at", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire", tab: "instructions" });
    await set(field("Instructions"), "A draft, not saved.", "input");
    // Paused: core is asked and the page read again.
    await press(onSwitch());
    const afterPause = field("Instructions").value;
    await openTab("Access");
    await openTab("Instructions");
    expect(asked.at(-1)).toStrictEqual(["paused", "agent-1", true]);
    expect([afterPause, field("Instructions").value]).toStrictEqual([
      "A draft, not saved.",
      "A draft, not saved.",
    ]);
    // And it is the draft that is saved.
    await press(button("Save"));
    expect(asked.at(-1)).toStrictEqual([
      "change",
      "agent-1",
      { ...claire, instructions: "A draft, not saved." },
    ]);
  });

  it("adds a time an agent works on its own, as a schedule core keeps, and pauses and removes it", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections, { agent: "Stephen", tab: "schedule" });
    await set(field("At, in the company's time zone"), "07:30", "input");
    await set(
      field("What to ask it each time"),
      " Look for invoices that are overdue. ",
      "input"
    );
    await press(button("Add a time"));
    expect(asked).toStrictEqual([
      [
        "wake",
        "organization",
        {
          cron: "30 7 * * 1-5",
          personId: "user-anna",
          opening: "Look for invoices that are overdue.",
        },
      ],
    ]);
    // Shown in words, for whom and with what it is asked.
    expect(document.body.textContent).toContain("Every weekday at 07:30");
    expect(document.body.textContent).toContain(
      "For Anna de Vries: Look for invoices that are overdue."
    );

    await press(toggle("Every weekday at 07:30, for Anna de Vries, is on"));
    await press(button("Remove Every weekday at 07:30, for Anna de Vries"));
    expect(asked.slice(1)).toStrictEqual([
      ["wake paused", "wake-1", true],
      ["wake deleted", "wake-1"],
    ]);
    expect(document.body.textContent).not.toContain("Every weekday at 07:30");
  });

  it("keeps what is typed of a new time while another change saves, and when core refuses it", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections, { agent: "Stephen", tab: "schedule" });
    await set(field("What to ask it each time"), "refuse this", "input");
    // Another change on the page saves and the page is read again.
    await press(onSwitch());
    expect(field("What to ask it each time").value).toBe("refuse this");
    // Core refuses it: still there to be corrected, and said why.
    await press(button("Add a time"));
    expect(asked.at(-1)?.[0]).toBe("wake");
    expect(field("What to ask it each time").value).toBe("refuse this");
    expect(document.body.textContent).toContain("That isn't a wake-up.");
  });

  it("shows the time zone a wake-up was made in", async () => {
    const { connections } = fakeConnections();
    await shown(connections, { agent: "Stephen", tab: "schedule" });
    await set(field("What to ask it each time"), "Check the inbox.", "input");
    await press(button("Add a time"));
    expect(document.body.textContent).toContain(
      "Every weekday at 09:00 · Europe/Amsterdam"
    );
  });

  it("saves each card's own fields over the agent as core has it now, never undoing what another card saved", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire" });
    const pen = document.querySelector("input[aria-label='Pen']");
    const model = document.querySelector("select");
    if (!(pen instanceof HTMLElement) || model === null) {
      throw new TypeError("Expected the picture and the model to choose");
    }
    await press(pen);
    await press(button("Save"));
    // The model's card was shown before the picture was saved.
    await set(model, "anthropic/claude-sonnet-4-5", "change");
    const [, saveModel] = [...document.querySelectorAll("button")].filter(
      (each) => each.textContent?.trim() === "Save"
    );
    if (saveModel === undefined) {
      throw new TypeError("Expected the model's Save");
    }
    await press(saveModel);
    // And the name's card before the model was.
    await set(field("Name"), "Clara", "input");
    await press(button("Save"));
    expect(asked).toStrictEqual([
      ["change", "agent-1", { ...claire, face: "pen" }],
      [
        "change",
        "agent-1",
        { ...claire, face: "pen", model: "anthropic/claude-sonnet-4-5" },
      ],
      [
        "change",
        "agent-1",
        {
          ...claire,
          name: "Clara",
          face: "pen",
          model: "anthropic/claude-sonnet-4-5",
        },
      ],
    ]);
  });
});
