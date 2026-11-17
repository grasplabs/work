// @vitest-environment happy-dom
import type {
  Agent,
  AgentDocument,
  AgentInput,
  AgentSettings,
  AgentWake,
  AgentWakeInput,
} from "@grasp-os/shared/agents";
import { chatFileMaxBytes } from "@grasp-os/shared/chat";
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
  createRoute,
  Outlet,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentPage, agentTabOf } from "./agent-page.tsx";
import type { AgentTab, FirstAgentAccess } from "./agent-page.tsx";
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

/** The first agent's access, as core keeps it for a company that changed nothing. */
const firstAccess: FirstAgentAccess = {
  reach: {
    on: true,
    audience: { who: "everyone" },
    changedBy: null,
    changedAt: null,
    places: [],
    apps: [],
    teams,
  },
  classes: [],
  week: null,
  workflows: null,
};

/** The models the organization chose. */
const models = ["anthropic/claude-sonnet-4-5"];

/** Core's agents, kept as an admin makes and changes them, and each change asked. */
const fakeConnections = () => {
  const asked: unknown[][] = [];
  let agents: Agent[] = [stephen];
  let wakes: AgentWake[] = [];
  let documents: (AgentDocument & { agentId: string })[] = [];
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
    agentDocuments: async (agentId: string): Promise<AgentDocument[]> => {
      await Promise.resolve();
      return documents.filter((each) => each.agentId === agentId);
    },
    addAgentDocument: async (
      agentId: string,
      file: { name: string; bytes: Uint8Array }
    ): Promise<AgentDocument> => {
      await Promise.resolve();
      asked.push([
        "document",
        agentId,
        file.name,
        new TextDecoder().decode(file.bytes),
      ]);
      // As core refuses a file that isn't what its name says.
      if (file.name.endsWith(".pdf")) {
        throw new Error("Only PDF, Word and text files can be attached.");
      }
      const made = {
        id: `document-${documents.length + 1}`,
        agentId,
        name: file.name,
        type: "md" as const,
        bytes: file.bytes.byteLength,
        addedAt: "2026-11-12T09:00:00.000Z",
      };
      documents = [...documents, made];
      return made;
    },
    removeAgentDocument: async (agentId: string, documentId: string) => {
      await Promise.resolve();
      asked.push(["document removed", agentId, documentId]);
      documents = documents.filter((each) => each.id !== documentId);
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
  documents: Record<string, AgentDocument[]>;
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
  const tab: AgentTab = open === "new" ? "overview" : (open.tab ?? "overview");
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
      documents={data.documents[agent.id]}
      editable={editable}
      first={agent.id === data.agents.at(0)?.id}
      firstAccess={agent.id === data.agents.at(0)?.id ? firstAccess : undefined}
      models={models}
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
    const kept = await Promise.all(
      agents.map(async ({ id }): Promise<[string, AgentDocument[]]> => [
        id,
        await connections.agentDocuments(id),
      ])
    );
    return {
      agents,
      settings: Object.fromEntries(read),
      wakes: Object.fromEntries(woken),
      documents: Object.fromEntries(kept),
    };
  };
  const rootRoute = createRootRoute({
    component: Outlet,
    // Where the new agent's page leads, when this router has no page for it.
    notFoundComponent: () => <p>Elsewhere</p>,
  });
  // The new agent's page, at the start.
  const start = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    loader: load,
    component: () => (
      <Page data={start.useLoaderData()} editable={editable} open={open} />
    ),
  });
  // An agent's own address, its tab in the search, as its tab links lead.
  const agentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agent",
    loader: load,
    validateSearch: (search: Record<string, unknown>) => ({
      tab: agentTabOf(search.tab),
    }),
    component: (): ReactNode => {
      const data: Shown = agentRoute.useLoaderData();
      const { agent } = agentRoute.useParams();
      const { tab } = agentRoute.useSearch();
      const name = data.agents.find(({ id }) => id === agent)?.name ?? "";
      return (
        <Page data={data} editable={editable} open={{ agent: name, tab }} />
      );
    },
  });
  const agents = await connections.agents();
  const agentId =
    open === "new"
      ? undefined
      : agents.find(({ name }) => name === open.agent)?.id;
  const address =
    open === "new" || agentId === undefined
      ? "/"
      : `/agents/${agentId}${open.tab === undefined ? "" : `?tab=${open.tab}`}`;
  const router = createRouter({
    routeTree: rootRoute.addChildren([start, agentRoute]),
    history: createMemoryHistory({ initialEntries: [address] }),
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
  element.closest("[hidden]") === null;

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

/** The button in view whose words are `name`, exactly. */
const exactButton = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => inView(each) && each.textContent?.trim() === name
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

/** The button in the open dialog whose words are `name`. */
const dialogButton = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("[role='dialog'] button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError(`No button ${name} in a dialog`);
  }
  return found;
};

/** Opens the tab named `name`: a link in the page's heading. */
const openTab = async (name: string) => {
  const tab = [...document.querySelectorAll("nav a")].find((each) =>
    each.textContent?.trim().startsWith(name)
  );
  if (!(tab instanceof HTMLElement)) {
    throw new TypeError(`No tab ${name}`);
  }
  await press(tab);
};

/** The field labelled `label`, on whichever tab or dialog it is. */
const field = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const named = [...document.querySelectorAll("label")].find((each) =>
    each.textContent?.trim().startsWith(label)
  );
  const found =
    named?.htmlFor === undefined || named.htmlFor === ""
      ? named?.parentElement?.querySelector("input, textarea")
      : document.querySelector(`#${CSS.escape(named.htmlFor)}`);
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

/** The switch on the row that says `words`. */
const rowSwitch = (words: string): HTMLElement => {
  const found = [...document.querySelectorAll("li")]
    .find((row) => row.textContent?.includes(words))
    ?.querySelector("[role='switch']");
  if (!(found instanceof HTMLElement)) {
    throw new TypeError(`No switch on ${words}`);
  }
  return found;
};

/** The switch in the page's heading, which turns the agent off and on. */
const onSwitch = (): HTMLElement => {
  const found = document.querySelector("header [role='switch']");
  if (!(found instanceof HTMLElement)) {
    throw new TypeError("No on switch");
  }
  return found;
};

/** Picks `files` in the documents' file picker, as a person does. */
const pick = async (...files: File[]) => {
  const input = document.querySelector("[data-testid='agent-document-input']");
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("No file picker");
  }
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
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

  it("has the first agent's reach on its own page, and no choice of the kind another agent has", async () => {
    const { connections } = fakeConnections();
    await shown(connections, { agent: "Stephen", tab: "access" });
    expect(choice("Who may use Stephen")).toBeNull();
    expect(document.body.textContent).toContain("Where people reach him");
    expect(document.querySelector("a[href='/settings/stephen']")).toBeNull();
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
    await press(button("Edit"));
    await set(field("Name"), "Clara", "input");
    await press(dialogButton("Save"));
    expect(asked).toStrictEqual([
      ["change", "agent-1", { ...claire, name: "Clara" }],
    ]);
  });

  it("pauses an agent from its heading, and says it is paused", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire" });
    await press(onSwitch());
    expect(asked).toStrictEqual([["paused", "agent-1", true]]);
    expect(document.querySelector("header")?.textContent).toContain("Paused");
  });

  it("offers someone who isn't the company's admin nothing to change", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire" }, false);
    expect({
      edit: button("Edit").disabled,
      on:
        Object.hasOwn(onSwitch().dataset, "disabled") ||
        onSwitch().getAttribute("aria-disabled") === "true" ||
        onSwitch().hasAttribute("disabled"),
    }).toStrictEqual({ edit: true, on: true });
    await openTab("Schedule");
    expect(document.body.textContent).toContain(
      "Claire only works when asked."
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
    await press(exactButton("Save"));
    expect(asked.at(-1)).toStrictEqual([
      "change",
      "agent-1",
      { ...claire, instructions: "A draft, not saved." },
    ]);
  });

  it("adds a time an agent works on its own, as a schedule core keeps, and pauses and removes it", async () => {
    const { connections, asked } = fakeConnections();
    await shown(connections, { agent: "Stephen", tab: "schedule" });
    await press(button("Add a time"));
    await set(field("At, in the company's time zone"), "07:30", "input");
    await set(
      field("What to ask it each time"),
      " Look for invoices that are overdue. ",
      "input"
    );
    await press(exactButton("Add"));
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

    await press(rowSwitch("Every weekday at 07:30"));
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
    await press(button("Add a time"));
    await set(field("What to ask it each time"), "refuse this", "input");
    // Another change on the page saves and the page is read again.
    await press(onSwitch());
    expect(field("What to ask it each time").value).toBe("refuse this");
    // Core refuses it: still there to be corrected, and said why.
    await press(exactButton("Add"));
    expect(asked.at(-1)?.[0]).toBe("wake");
    expect(field("What to ask it each time").value).toBe("refuse this");
    expect(document.body.textContent).toContain("That isn't a wake-up.");
  });

  it("shows the time zone a wake-up was made in", async () => {
    const { connections } = fakeConnections();
    await shown(connections, { agent: "Stephen", tab: "schedule" });
    await press(button("Add a time"));
    await set(field("What to ask it each time"), "Check the inbox.", "input");
    await press(exactButton("Add"));
    const row = [...document.querySelectorAll("li")].find((each) =>
      each.textContent?.includes("Every weekday at 09:00")
    );
    expect(row?.textContent).toContain("Europe/Amsterdam");
  });

  it("saves each card's own fields over the agent as core has it now, never undoing what another card saved", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire", tab: "instructions" });
    // The instructions were shown before the picture was saved.
    await set(field("Instructions"), "Only invoices over 30 days.", "input");
    await press(button("Edit"));
    await press(button("Pen"));
    await press(dialogButton("Save"));
    await press(exactButton("Save"));
    // And the name is asked for after both.
    await press(button("Edit"));
    await set(field("Name"), "Clara", "input");
    await press(dialogButton("Save"));
    const said = "Only invoices over 30 days.";
    expect(asked).toStrictEqual([
      ["change", "agent-1", { ...claire, face: "pen" }],
      ["change", "agent-1", { ...claire, face: "pen", instructions: said }],
      [
        "change",
        "agent-1",
        { ...claire, name: "Clara", face: "pen", instructions: said },
      ],
    ]);
  });

  it("gives an agent the files an admin picks, each with its name and content, lists them, and removes one", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire", tab: "instructions" });
    await pick(
      new File(["# Close\n\nTwo signatures."], "Close checklist.md"),
      new File(["Net 30."], "Terms.txt")
    );
    const listed = document.body.textContent;
    await press(button("Remove Close checklist.md"));
    expect({
      asked,
      listed: [
        listed.includes("Close checklist.md"),
        listed.includes("Terms.txt"),
      ],
      after: [
        document.body.textContent.includes("Close checklist.md"),
        document.body.textContent.includes("Terms.txt"),
      ],
      // Who may learn what a document says, said where one is added.
      warned: listed.includes("Anyone who may ask it can learn what they say."),
    }).toStrictEqual({
      asked: [
        [
          "document",
          "agent-1",
          "Close checklist.md",
          "# Close\n\nTwo signatures.",
        ],
        ["document", "agent-1", "Terms.txt", "Net 30."],
        ["document removed", "agent-1", "document-1"],
      ],
      listed: [true, true],
      after: [false, true],
      warned: true,
    });
  });

  it("says why a file wasn't taken, keeps those taken before it, and stops there", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire", tab: "instructions" });
    await pick(
      new File(["a"], "a.md"),
      new File(["not a PDF"], "policy.pdf"),
      new File(["c"], "c.md")
    );
    expect({
      asked: asked.map((each) => each[2]),
      said: document.body.textContent.includes(
        "Only PDF, Word and text files can be attached."
      ),
      kept: document.body.textContent.includes("a.md"),
    }).toStrictEqual({
      asked: ["a.md", "policy.pdf"],
      said: true,
      kept: true,
    });
  });

  it("never sends core a file larger than it takes, or of a type it doesn't, and says why", async () => {
    const { connections, asked } = await withClaire();
    await shown(connections, { agent: "Claire", tab: "instructions" });
    const large = new File(["a"], "large.md");
    Object.defineProperty(large, "size", { value: chatFileMaxBytes + 1 });
    await pick(large);
    const tooLarge = document.body.textContent.includes(
      "A document is at most 10 MB"
    );
    await pick(new File(["MZ"], "tool.exe"));
    expect({
      asked,
      tooLarge,
      unsupported: document.body.textContent.includes(
        "A document is a PDF, Word (.docx)"
      ),
    }).toStrictEqual({ asked: [], tooLarge: true, unsupported: true });
  });

  it("shows someone who isn't the company's admin an agent's documents, with no way to add or remove one", async () => {
    const { connections, asked } = await withClaire();
    await connections.addAgentDocument("agent-1", {
      name: "Terms.txt",
      bytes: new TextEncoder().encode("Net 30."),
    });
    asked.length = 0;
    await shown(connections, { agent: "Claire", tab: "instructions" }, false);
    expect({
      listed: document.body.textContent.includes("Terms.txt"),
      add: document.body.textContent.includes("Add document"),
      picker: document.querySelector("[data-testid='agent-document-input']"),
      remove: [...document.querySelectorAll("button")].some(
        (each) => each.getAttribute("aria-label") === "Remove Terms.txt"
      ),
      asked,
    }).toStrictEqual({
      listed: true,
      add: false,
      picker: null,
      remove: false,
      asked: [],
    });
  });
});
