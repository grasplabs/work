// @vitest-environment happy-dom
import type {
  Agent,
  AgentApp,
  AgentAppsWorkedOut,
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
import type {
  InstructionFileRef,
  InstructionFileText,
  InstructionsApi,
} from "@grasp-os/shared/instruction-files";
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
import type { AnyRouter } from "@tanstack/react-router";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AgentPage } from "./agent-page.tsx";
import type { FirstAgentAccess } from "./agent-page.tsx";
import { ManualAgent } from "./manual-agent.tsx";
import { NewAgent } from "./new-agent.tsx";
import { agentTabOf } from "./tabs.tsx";
import type { AgentTab } from "./tabs.tsx";
import { agentInstructionsFor } from "./unsaved-instructions.ts";
import type { UnsavedInstructions } from "./unsaved-instructions.ts";

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
  modelRole: null,
  model: null,
  state: "on",
  ownerId: null,
  offeredAt: null,
  changedBy: null,
  changedAt: null,
};

const anna: Member = {
  userId: "user-anna",
  name: "Anna de Vries",
  email: "anna@acme.test",
  role: "user",
  joinedAt: "2026-01-05T09:00:00.000Z",
  suspension: null,
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

/** Whether the page says the Brain couldn't be reached, as the fake refuses. */
const saysOutOfReach = (): boolean =>
  document.body.textContent.includes("The Brain can't be reached. Try again.");

/** The agent whose instruction file `file` is. */
const agentOf = (file: InstructionFileRef): string =>
  file.scope === "agent" ? file.agentId : "not an agent's";

/** Core's agents, kept as an admin makes and changes them, and each change asked. */
const fakeConnections = () => {
  const asked: unknown[][] = [];
  let agents: Agent[] = [stephen];
  let wakes: AgentWake[] = [];
  let documents: (AgentDocument & { agentId: string })[] = [];
  const settings = new Map<string, AgentSettings>();
  const apps = new Map<string, AgentApp[]>();
  // Each agent's instruction file, by its ID, as core's
  // `session.instructions` keeps it.
  const files = new Map<string, InstructionFileText>();
  // Saves and reads to refuse, as a Brain out of reach would.
  const outOfReach = { saves: 0, reads: 0 };
  const instructions: InstructionsApi = {
    read: async (file) => {
      await Promise.resolve();
      if (outOfReach.reads > 0) {
        outOfReach.reads -= 1;
        throw new Error("The Brain can't be reached. Try again.");
      }
      return files.get(agentOf(file)) ?? null;
    },
    save: async ({ file, text, after }) => {
      await Promise.resolve();
      asked.push(["told", agentOf(file), text]);
      if (outOfReach.saves > 0) {
        outOfReach.saves -= 1;
        throw new Error("The Brain can't be reached. Try again.");
      }
      // As core refuses a save over a version it didn't start from.
      const now = files.get(agentOf(file));
      if ((now?.version ?? 0) !== after) {
        throw new Error("Someone saved this instruction file since.");
      }
      const version = after + 1;
      files.set(agentOf(file), { version, text });
      return { version };
    },
  };
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
        ownerId: null,
        offeredAt: null,
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
    makeOwnAgent: async (input: AgentInput): Promise<Agent> => {
      await Promise.resolve();
      asked.push(["make own", input]);
      const made: Agent = {
        id: `agent-${agents.length}`,
        ...input,
        model: input.model ?? null,
        state: "on",
        ownerId: "user-me",
        offeredAt: null,
        changedBy: "user-me",
        changedAt: "2026-11-12T09:00:00.000Z",
      };
      // As core makes it: theirs alone, with no settings of its own.
      agents = [...agents, made];
      return made;
    },
    offerOwnAgent: async (id: string, offered: boolean) => {
      await Promise.resolve();
      asked.push(["offer", id, offered]);
      changed(id, { offeredAt: offered ? "2026-11-13T09:00:00.000Z" : null });
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
    agentApps: async (agentId: string): Promise<AgentApp[]> => {
      await Promise.resolve();
      return apps.get(agentId) ?? [];
    },
    setAgentApp: async (agentId: string, app: string, on: boolean) => {
      await Promise.resolve();
      asked.push(["app", agentId, app, on]);
      const rest = (apps.get(agentId) ?? []).filter((each) => each.app !== app);
      apps.set(agentId, [
        ...rest,
        {
          app,
          name: app === "native:google" ? "Google Workspace" : app,
          state: on ? "on" : "removed",
          source: "person",
        },
      ]);
    },
    workOutAgentApps: async (agentId: string): Promise<AgentAppsWorkedOut> => {
      await Promise.resolve();
      asked.push(["work out", agentId]);
      const added: AgentApp[] = [
        {
          app: "native:google",
          name: "Google Workspace",
          state: "on",
          source: "instructions",
        },
      ];
      apps.set(agentId, added);
      return {
        added,
        turnedOn: ["read-own"],
        suggested: ["reach-others"],
        missing: ["Slack"],
        schedule: { cron: "0 8 * * 1", opening: "Sum up the week." },
      };
    },
    requestApp: async (request: { name: string; why?: string }) => {
      await Promise.resolve();
      asked.push(["request app", request.name]);
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
  return { connections, instructions, outOfReach, asked };
};

type Fake = ReturnType<typeof fakeConnections>;
type Connections = Fake["connections"];

let root: Root | undefined;

/** What the page's route read. */
interface Shown {
  agents: Agent[];
  instructions: Record<string, InstructionFileText | null | undefined>;
  unsaved: Record<string, UnsavedInstructions | undefined>;
  apps: Record<string, AgentApp[]>;
  settings: Record<string, AgentSettings>;
  wakes: Record<string, AgentWake[]>;
  documents: Record<string, AgentDocument[]>;
}

/**
 * What is shown: one agent's page, by its name, or the new agent's, with
 * the company's agents of people's own on, or off, or set up by hand.
 */
type Open =
  | { agent: string; tab?: AgentTab }
  | "new"
  | "new-own-off"
  | "new-guided";

/** The router of the page shown, to open another of its parts. */
let shownRouter: AnyRouter | undefined;

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
  const tab: AgentTab =
    typeof open === "string" ? "overview" : (open.tab ?? "overview");
  if (open === "new-guided") {
    return (
      <ManualAgent
        apps={[]}
        company={editable}
        models={models}
        own
        personId={anna.userId}
        taken={data.agents.map(({ name }) => name)}
        teams={teams}
      />
    );
  }
  if (typeof open === "string") {
    return (
      <NewAgent
        company={editable}
        own={open === "new"}
        personId={anna.userId}
        taken={data.agents.map(({ name }) => name)}
      />
    );
  }
  const agent = data.agents.find(({ name }) => name === open.agent);
  if (agent === undefined) {
    return <p>No such agent</p>;
  }
  return (
    <AgentPage
      agent={agent}
      apps={{
        apps: data.apps[agent.id],
        offered: [
          {
            source: "native",
            id: "google",
            name: "Google Workspace",
            categories: ["email"],
            description: "Mail, calendar and documents",
            logo: null,
          },
          {
            source: "composio",
            id: "hubspot",
            name: "HubSpot",
            categories: ["crm"],
            description: "Deals and contacts",
            logo: null,
          },
        ],
        // Google Workspace is connected; HubSpot isn't yet.
        connected: ["google"],
        userId: "user-1",
      }}
      documents={data.documents[agent.id]}
      editable={editable}
      // Read only for whoever may change it, as its route reads it.
      instructions={data.instructions[agent.id]}
      unsaved={data.unsaved[agent.id]}
      first={agent.id === data.agents.at(0)?.id}
      firstAccess={agent.id === data.agents.at(0)?.id ? firstAccess : undefined}
      models={models}
      people={people}
      onTab={(next) => {
        void shownRouter?.navigate({
          to: ".",
          search: next === "overview" ? {} : { tab: next },
        });
      }}
      settings={data.settings[agent.id]}
      tab={tab}
      teams={teams}
      usable
      usage={undefined}
      wakes={data.wakes[agent.id] ?? []}
    />
  );
};

/** `open` on what `fake` holds, for the company's admin when `editable`. */
const shown = async (
  { connections, instructions }: Fake,
  open: Open,
  editable = true
) => {
  const core = {
    withSession: async <T,>(
      action: (session: {
        connections: Connections;
        instructions: InstructionsApi;
      }) => Promise<T>
    ): Promise<T> => await action({ connections, instructions }),
  };
  const load = async (): Promise<Shown> => {
    const agents = await connections.agents();
    const read = await Promise.all(
      agents
        .slice(1)
        // A person's own agent has no settings to read.
        .filter(({ ownerId }) => ownerId === null)
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
    // Each agent's file and what its New agent page couldn't save, read
    // as the route reads them.
    const told = await Promise.all(
      agents.map(
        async ({ id }) =>
          [
            id,
            await agentInstructionsFor({ instructions }, id, editable),
          ] as const
      )
    );
    const given = await Promise.all(
      agents.map(async ({ id }): Promise<[string, AgentApp[]]> => [
        id,
        await connections.agentApps(id),
      ])
    );
    return {
      agents,
      instructions: Object.fromEntries(
        told.map(([id, { instructions: file }]) => [id, file])
      ),
      unsaved: Object.fromEntries(
        told.map(([id, { unsaved }]) => [id, unsaved])
      ),
      apps: Object.fromEntries(given),
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
    typeof open === "string"
      ? undefined
      : agents.find(({ name }) => name === open.agent)?.id;
  const address =
    typeof open === "string" || agentId === undefined
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
  shownRouter = router;
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

/** Opens the agent's part `tab`, as its row in the sidebar leads there. */
const openTab = async (tab: AgentTab) => {
  await act(async () => {
    await shownRouter?.navigate({
      to: ".",
      search: tab === "overview" ? {} : { tab },
    });
  });
  await settled();
};

/** The field labelled `label`, on whichever tab or dialog it is. */
const field = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const named = [...document.querySelectorAll("label")].find((each) =>
    each.textContent?.trim().startsWith(label)
  );
  const byLabel = (): Element | null | undefined => {
    if (named === undefined) {
      // A field alone in its card is named by the card, not a label.
      return document.querySelector(
        `input[aria-label="${label}"], textarea[aria-label="${label}"]`
      );
    }
    return named.htmlFor === ""
      ? named.parentElement?.querySelector("input, textarea")
      : document.querySelector(`#${CSS.escape(named.htmlFor)}`);
  };
  const found = byLabel();
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

/** Whether the row a radio stands in, and no other radio's, says `words`. */
const saysOnItsRow = (radio: HTMLElement, words: string): boolean => {
  let row: HTMLElement | null = radio;
  while (row !== null && row.querySelectorAll("[role='radio']").length <= 1) {
    if (row.textContent?.includes(words)) {
      return true;
    }
    row = row.parentElement;
  }
  return false;
};

/**
 * The answer in the question Grasp asks now: the radio whose row says
 * `words`, or the box for words of one's own that `words` names.
 */
const answer = (words: string): HTMLElement => {
  const found =
    [
      ...document.querySelectorAll<HTMLElement>(
        "[data-slot='questionnaire'] [role='radio']"
      ),
    ].find((each) => saysOnItsRow(each, words)) ??
    document.querySelector<HTMLElement>(
      `[data-slot='questionnaire'] input[aria-label="${words}"]`
    ) ??
    undefined;
  if (found === undefined) {
    throw new TypeError(`No answer ${words}`);
  }
  return found;
};

/** The box Grasp's question takes words in: its own text box, or its Other row's. */
const answerBox = (): HTMLInputElement | HTMLTextAreaElement => {
  const found = document.querySelector(
    "[data-slot='questionnaire'] input:not([type='radio'], [type='checkbox'], [type='hidden']), [data-slot='questionnaire'] textarea"
  );
  if (
    !(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)
  ) {
    throw new TypeError("No answer box");
  }
  return found;
};

/** The choice labelled `label` (a library Select's trigger), or none. */
const choice = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[role="combobox"][aria-label="${label}"], select[aria-label="${label}"]`
  );

/** What a choice shows as chosen, without what is hidden from a screen reader. */
const chosenIn = (label: string): string | undefined => {
  const found = choice(label);
  if (found === null) {
    return undefined;
  }
  if (found instanceof HTMLSelectElement) {
    return found.selectedOptions[0]?.textContent.trim();
  }
  const copy = found.cloneNode(true);
  if (!(copy instanceof Element)) {
    return undefined;
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent.trim();
};

/** Opens the choice labelled `label` and picks the option that says `name`. */
const choose = async (label: string, name: string) => {
  const control = choice(label);
  if (control === null) {
    throw new TypeError(`No choice ${label}`);
  }
  // A plain select (Settings' audience control) is chosen in place.
  if (control instanceof HTMLSelectElement) {
    const picked = [...control.options].find(
      (each) => each.textContent.trim() === name
    );
    if (picked === undefined) {
      throw new TypeError(`No option ${name}`);
    }
    await set(control, picked.value, "change");
    return;
  }
  await press(control);
  const list = document.querySelector(
    `[id="${control.getAttribute("aria-controls") ?? ""}"]`
  );
  const option = [
    ...(list ?? document).querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((each) => each.textContent.trim() === name);
  if (option === undefined) {
    throw new TypeError(`No option ${name}`);
  }
  await press(option);
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

/** The heading's "…" button, which holds Edit, turning it off or on, and Delete. */
const moreButton = (): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((each) =>
    (each.getAttribute("aria-label") ?? "").startsWith("More for")
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError("No More button");
  }
  return found;
};

/** The open menu's item whose words start with `words`. */
const menuItem = (words: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (each) => each.textContent.trim().startsWith(words)
  );

/** The heading's menu item whose words start with `words`, the menu opened first. */
const fromMenu = async (words: string): Promise<HTMLElement> => {
  await press(moreButton());
  const found = menuItem(words);
  if (found === undefined) {
    throw new TypeError(`No menu item ${words}`);
  }
  return found;
};

/** Whether `element` can't be chosen now. */
const isDisabled = (element: HTMLElement): boolean =>
  Object.hasOwn(element.dataset, "disabled") ||
  element.getAttribute("aria-disabled") === "true" ||
  element.hasAttribute("disabled");

/** The switch in the settings row that says `words`. */
const settingSwitch = (words: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>("[role='switch']"),
  ].find((each) => {
    const rows = each.closest("[data-orientation='responsive']");
    return rows !== null && rows.textContent.includes(words);
  });
  if (found === undefined) {
    throw new TypeError(`No setting switch ${words}`);
  }
  return found;
};

/** The words of the agent's documents' list. */
const documentsListed = (): string =>
  document.querySelector("ul[aria-label='Documents']")?.textContent ?? "";

/** Picks `files` in the documents' file picker, as a person does. */
const pick = async (...files: File[]) => {
  const input = document.querySelector(
    "[data-slot='file-upload'] input[type='file']"
  );
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
  face: "stephen",
  model: null,
  modelRole: null,
};

/** What Claire is told, in her instruction file. */
const claireTold = "Answer only about invoices.";

/** Core with an agent named Claire an admin made and told earlier, and nothing asked since. */
const withClaire = async () => {
  const fake = fakeConnections();
  const made = await fake.connections.makeAgent(claire);
  await fake.instructions.save({
    file: { scope: "agent", agentId: made.id },
    change: "told-earlier",
    text: claireTold,
    after: 0,
  });
  fake.asked.length = 0;
  return fake;
};

/**
 * Answers the new agent's questions in a chat as a person does: a job in
 * their own words, `name`, the shape and colours offered, then whom it is
 * for where they are asked (`whose`: the offered answer, or Just for me),
 * the schedule offered where it is asked, and `instructions`; then
 * Review and Make agent.
 */
const makeInChat = async ({
  name,
  instructions,
  whose,
}: {
  name: string;
  instructions: string;
  /** `offered` as offered, `mine` Just for me, `unasked` for one who isn't asked. */
  whose: "offered" | "mine" | "unasked";
}) => {
  await press(answer("Something else"));
  await set(answerBox(), "Chases unpaid invoices.", "input");
  await press(button("Next"));
  await set(answerBox(), name, "input");
  await press(button("Next"));
  await press(button("Next"));
  await press(button("Next"));
  if (whose === "mine") {
    await press(answer("Just for me"));
    await press(button("Next"));
  }
  if (whose === "offered") {
    // Everyone in the company, and only when asked: as offered.
    await press(button("Next"));
    await press(button("Next"));
  }
  await set(answerBox(), instructions, "input");
  await press(button("Review"));
  await press(button("Make agent"));
};

/** The radio whose row says `words`, in whatever is asked now. */
const radio = (words: string): HTMLElement => {
  // The library's radios, or the setup's cards, each a native radio in its label.
  const found =
    [...document.querySelectorAll<HTMLElement>("[role='radio']")].find((each) =>
      saysOnItsRow(each, words)
    ) ??
    [
      ...document.querySelectorAll<HTMLInputElement>(
        "fieldset[role='radiogroup'] input[type='radio']"
      ),
    ].find(
      (each) => each.closest("label")?.textContent?.includes(words) === true
    );
  if (found === undefined) {
    throw new TypeError(`No radio ${words}`);
  }
  return found;
};

/**
 * Goes through the guided setup as a person does, naming it `name` and
 * saying what it is for, every other answer as offered, up to Make agent;
 * says each question asked, in order, after the ones `before`.
 */
const setUpByHand = async (
  name: string,
  before: readonly string[] = []
): Promise<string[]> => {
  const question = document.querySelector("h1")?.textContent ?? "";
  const questions = [...before, question];
  // A dozen at most: more is a setup that never ends.
  if (question.startsWith("Ready to make") || questions.length > 12) {
    return questions;
  }
  if (question === "What should we call your agent?") {
    await set(field("Name"), name, "input");
  }
  if (question === `What should ${name} do?`) {
    await set(field("What it is for"), "Chases unpaid invoices.", "input");
  }
  await press(button("Next"));
  return await setUpByHand(name, questions);
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
    const fake = fakeConnections();
    await shown(fake, { agent: "Stephen", tab: "access" });
    expect(choice("Who may use Stephen")).toBeNull();
    expect(document.body.textContent).toContain("Where people reach him");
    expect(document.body.textContent).toContain("Grasp's chat");
  });

  it("makes an agent from the answers to Grasp's questions, in the look chosen, and leads to its access", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    const router = await shown(fake, "new");
    await press(answer("Something else"));
    await set(answerBox(), "Chases unpaid invoices.", "input");
    await press(button("Next"));
    await set(answerBox(), " Claire ", "input");
    await press(button("Next"));
    await press(answer("Triangle"));
    await press(button("Next"));
    await press(answer("Ember"));
    await press(button("Next"));
    await press(answer("Nobody yet"));
    await press(button("Next"));
    // Only when asked: as offered.
    await press(button("Next"));
    await set(answerBox(), "Answer only about invoices.", "input");
    await press(button("Review"));
    await press(button("Make agent"));
    expect(asked).toStrictEqual([
      ["make", { ...claire, face: "figure-prism-ember" }],
      // What it is told: its instruction file's first version.
      ["told", "agent-1", claireTold],
      ["work out", "agent-1"],
    ]);
    expect(router.state.location.href).toBe("/agents/agent-1?tab=access");
  });

  it("makes a starting point's agent for everyone, working on its own for the one who made it", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    const router = await shown(fake, "new");
    await press(answer("Chase unpaid invoices"));
    await press(button("Next"));
    // Its suggested name, shape and colours, as offered.
    await press(button("Next"));
    await press(button("Next"));
    await press(button("Next"));
    await press(answer("Everyone in the company"));
    await press(button("Next"));
    await press(answer("Every weekday at 9:00"));
    await press(button("Next"));
    await press(button("Review"));
    await press(button("Make agent"));
    const [made] = asked;
    expect(made?.[1]).toMatchObject({ name: "Invoice chaser" });
    expect({
      rest: asked.slice(1),
    }).toStrictEqual({
      rest: [
        // Its starting point's instructions, as its file's first version.
        ["told", "agent-1", expect.any(String)],
        ["work out", "agent-1"],
        ["reach", "agent-1", true, { who: "everyone" }],
        [
          "wake",
          "agent-1",
          {
            cron: "0 9 * * 1-5",
            personId: anna.userId,
            opening: "Chases unpaid invoices and drafts the reminders.",
          },
        ],
      ],
    });
    // Its page opens where it was made, not on its access: that is chosen already.
    expect({
      page: router.state.location.pathname,
      access: router.state.location.href.includes("tab=access"),
    }).toStrictEqual({ page: "/agents/agent-1", access: false });
  });

  it("opens a new agent reaching nobody, and saves whom it answers and what it may do as an admin chooses them", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "access" });
    const before = [
      chosenIn("Who may use Claire"),
      chosenIn("Read their own, for Claire"),
    ];
    await choose("Who may use Claire", "Everyone");
    await choose("Read their own, for Claire", "As the company has it");
    expect(before).toStrictEqual(["Nobody yet", "Nobody yet"]);
    expect(asked).toStrictEqual([
      ["reach", "agent-1", true, { who: "everyone" }],
      ["class", "agent-1", "read-own", { who: "asClass" }],
    ]);
    // Read again from core: the page shows what it keeps.
    expect(chosenIn("Who may use Claire")).toBe("Everyone");
    expect(chosenIn("Read their own, for Claire")).toBe(
      "As the company has it"
    );
  });

  it("saves a new name with the rest of the agent as it was", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire" });
    await press(await fromMenu("Edit"));
    await set(field("Name"), "Clara", "input");
    await press(dialogButton("Save"));
    expect(asked).toStrictEqual([
      ["change", "agent-1", { ...claire, name: "Clara" }],
    ]);
  });

  it("pauses an agent from its heading, and says it is paused", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire" });
    await press(await fromMenu("Turn off"));
    expect(asked).toStrictEqual([["paused", "agent-1", true]]);
    expect(document.querySelector("header")?.textContent).toContain("Off");
  });

  it("offers someone who isn't the company's admin nothing to change", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire" }, false);
    const edit = isDisabled(await fromMenu("Edit"));
    const turnOff = menuItem("Turn off");
    const off = turnOff !== undefined && isDisabled(turnOff);
    // Closed again before the tabs are pressed.
    await press(moreButton());
    expect({ edit, off }).toStrictEqual({ edit: true, off: true });
    await openTab("schedule");
    expect(document.body.textContent).toContain(
      "Claire only works when asked."
    );
    expect(document.body.textContent).not.toContain("Add a time");
    expect(asked).toStrictEqual([]);
  });

  it("takes no name another agent has, and says why where it was typed", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    await shown(fake, "new");
    await press(answer("Something else"));
    await set(answerBox(), "Answers questions about leave.", "input");
    await press(button("Next"));
    await set(answerBox(), "stephen", "input");
    await press(button("Next"));
    expect({
      said: document.body.textContent?.includes("Another agent has this name"),
      kept: answerBox().value,
      asked,
    }).toStrictEqual({ said: true, kept: "stephen", asked: [] });
  });

  it("keeps what is typed and not yet saved while the agent is paused, and while another tab is looked at", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "instructions" });
    await set(field("Instructions"), "A draft, not saved.", "input");
    // Paused: core is asked and the page read again.
    await press(await fromMenu("Turn off"));
    const afterPause = field("Instructions").value;
    await openTab("access");
    await openTab("instructions");
    expect(asked.at(-1)).toStrictEqual(["paused", "agent-1", true]);
    expect([afterPause, field("Instructions").value]).toStrictEqual([
      "A draft, not saved.",
      "A draft, not saved.",
    ]);
    // And it is the draft that is saved, as its instruction file.
    await press(exactButton("Save"));
    expect(asked.slice(-2)).toStrictEqual([
      ["told", "agent-1", "A draft, not saved."],
      ["work out", "agent-1"],
    ]);
  });

  it("adds a time an agent works on its own, as a schedule core keeps, and pauses and removes it", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    await shown(fake, { agent: "Stephen", tab: "schedule" });
    await press(button("Add a time"));
    await set(field("Time"), "07:30", "input");
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
    const fake = fakeConnections();
    const { asked } = fake;
    await shown(fake, { agent: "Stephen", tab: "schedule" });
    await press(button("Add a time"));
    await set(field("What to ask it each time"), "refuse this", "input");
    // Another change on the page saves and the page is read again.
    await press(await fromMenu("Turn off"));
    expect(field("What to ask it each time").value).toBe("refuse this");
    // Core refuses it: still there to be corrected, and said why.
    await press(exactButton("Add"));
    expect(asked.at(-1)?.[0]).toBe("wake");
    expect(field("What to ask it each time").value).toBe("refuse this");
    expect(document.body.textContent).toContain("That isn't a wake-up.");
  });

  it("shows the time zone a wake-up was made in, by its name", async () => {
    const fake = fakeConnections();
    await shown(fake, { agent: "Stephen", tab: "schedule" });
    await press(button("Add a time"));
    await set(field("What to ask it each time"), "Check the inbox.", "input");
    await press(exactButton("Add"));
    const row = [...document.querySelectorAll("li")].find((each) =>
      each.textContent?.includes("Every weekday at 09:00")
    );
    // Europe/Amsterdam, as the page's language names it.
    expect(row?.textContent).toContain("Central European Time");
  });

  it("saves each card's own fields over the agent as core has it now, never undoing what another card saved", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "instructions" });
    // The name's dialog is opened after the instructions were saved.
    await set(field("Instructions"), "Only invoices over 30 days.", "input");
    await press(exactButton("Save"));
    await press(await fromMenu("Edit"));
    await set(field("Name"), "Clara", "input");
    await press(dialogButton("Save"));
    expect(asked).toStrictEqual([
      ["told", "agent-1", "Only invoices over 30 days."],
      ["work out", "agent-1"],
      ["change", "agent-1", { ...claire, name: "Clara" }],
    ]);
  });

  it("gives an agent the files an admin picks, each with its name and content, lists them, and removes one", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "instructions" });
    await pick(
      new File(["# Close\n\nTwo signatures."], "Close checklist.md"),
      new File(["Net 30."], "Terms.txt")
    );
    const listed = document.body.textContent;
    await press(button("Remove Close checklist.md"));
    // It asks first: a removed document can't be put back without its file.
    await press(button("Remove"));
    expect({
      asked,
      listed: [
        listed.includes("Close checklist.md"),
        listed.includes("Terms.txt"),
      ],
      // The agent's documents, as their list has them once core kept them.
      after: [
        documentsListed().includes("Close checklist.md"),
        documentsListed().includes("Terms.txt"),
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

  it("says why a file wasn't taken, and keeps the others", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "instructions" });
    await pick(
      new File(["a"], "a.md"),
      new File(["not a PDF"], "policy.pdf"),
      new File(["c"], "c.md")
    );
    // Each file is sent on its own: one core refuses stops none of the rest.
    expect({
      asked: asked.map((each) => each[2]),
      said: document.body.textContent.includes(
        "Only PDF, Word and text files can be attached."
      ),
      kept: ["a.md", "c.md"].map((file) => documentsListed().includes(file)),
    }).toStrictEqual({
      asked: ["a.md", "policy.pdf", "c.md"],
      said: true,
      kept: [true, true],
    });
  });

  it("never sends core a file larger than it takes, or of a type it doesn't, and says why", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "instructions" });
    const large = new File(["a"], "large.md");
    Object.defineProperty(large, "size", { value: chatFileMaxBytes + 1 });
    await pick(large);
    const tooLarge = document.body.textContent.includes(
      "large.md is too large."
    );
    await pick(new File(["MZ"], "tool.exe"));
    expect({
      asked,
      tooLarge,
      unsupported: document.body.textContent.includes(
        "tool.exe is not a kind of file this takes."
      ),
    }).toStrictEqual({ asked: [], tooLarge: true, unsupported: true });
  });

  it("shows someone who isn't the company's admin an agent's documents, with no way to add or remove one", async () => {
    const fake = await withClaire();
    const { connections, asked } = fake;
    await connections.addAgentDocument("agent-1", {
      name: "Terms.txt",
      bytes: new TextEncoder().encode("Net 30."),
    });
    asked.length = 0;
    await shown(fake, { agent: "Claire", tab: "instructions" }, false);
    expect({
      listed: document.body.textContent.includes("Terms.txt"),
      add: document.body.textContent.includes("Add document"),
      picker: document.querySelector(
        "[data-slot='file-upload'] input[type='file']"
      ),
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

  it("refuses instructions their save would refuse, counted as it counts them, before anything is made", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    const router = await shown(fake, "new");
    // Under the limit as typed, over it once each & is escaped.
    const typed = `${"&".repeat(10)}${"x".repeat(7980)}`;
    await makeInChat({ name: "Claire", instructions: typed, whose: "offered" });
    expect({
      length: typed.length,
      asked,
      at: router.state.location.pathname,
      said: document.body.textContent.includes(
        "This instruction file is over its size limit."
      ),
    }).toStrictEqual({ length: 7990, asked: [], at: "/", said: true });
  });

  it("keeps instructions it couldn't save while their file can't be read either, shows them once it can, and drops them once saved", async () => {
    const fake = fakeConnections();
    fake.outOfReach.saves = 1;
    await shown(fake, "new");
    // The Brain still out of reach as its page opens: no file read, for
    // either agent.
    fake.outOfReach.reads = 2;
    await makeInChat({
      name: "Claire",
      instructions: claireTold,
      whose: "offered",
    });
    const unreadable = document.body.textContent.includes("Not shown");
    /** The agent's page, opened again, as the address it was sent to. */
    const reopened = async (): Promise<void> => {
      act(() => {
        root?.unmount();
      });
      document.body.replaceChildren();
      await shown(fake, { agent: "Claire", tab: "instructions" });
    };
    await reopened();
    const readable = {
      text: field("Instructions").value,
      said: saysOutOfReach(),
    };
    await press(exactButton("Save"));
    await reopened();
    expect({
      unreadable,
      readable,
      afterSave: { text: field("Instructions").value, said: saysOutOfReach() },
      saved: await fake.instructions.read({
        scope: "agent",
        agentId: "agent-1",
      }),
    }).toStrictEqual({
      unreadable: true,
      readable: { text: claireTold, said: true },
      // Saved, nothing is handed over again: the editor shows the file.
      afterSave: { text: claireTold, said: false },
      saved: { version: 1, text: claireTold },
    });
  });

  it("makes the agent all the same when its instructions can't be saved, opens them on its page unsaved with why, and saves them once on a press", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    fake.outOfReach.saves = 1;
    const router = await shown(fake, "new");
    await makeInChat({
      name: "Claire",
      instructions: claireTold,
      whose: "offered",
    });
    // Its page, as the address it was sent to opens it.
    const at = router.state.location.href;
    const shownThen = {
      text: field("Instructions").value,
      said: saysOutOfReach(),
    };
    await press(exactButton("Save"));
    expect({
      at,
      shownThen,
      asked,
      saved: await fake.instructions.read({
        scope: "agent",
        agentId: "agent-1",
      }),
      saidAfter: saysOutOfReach(),
    }).toStrictEqual({
      at: "/agents/agent-1?tab=instructions",
      shownThen: { text: claireTold, said: true },
      asked: [
        ["make", expect.objectContaining({ name: "Claire" })],
        ["told", "agent-1", claireTold],
        // For everyone, as offered.
        ["reach", "agent-1", true, { who: "everyone" }],
        ["told", "agent-1", claireTold],
        ["work out", "agent-1"],
      ],
      saved: { version: 1, text: claireTold },
      saidAfter: false,
    });
  });

  it("makes an agent of the person's own for someone who isn't an admin, never asking whom it is for, and opens its page", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    const router = await shown(fake, "new", false);
    await makeInChat({
      name: "Claire",
      instructions: claireTold,
      whose: "unasked",
    });
    expect({
      asked,
      page: router.state.location.pathname,
      tab: router.state.location.href.includes("tab=instructions"),
    }).toStrictEqual({
      asked: [
        ["make own", expect.objectContaining({ name: "Claire" })],
        ["told", "agent-1", claireTold],
        ["work out", "agent-1"],
      ],
      page: "/agents/agent-1",
      tab: false,
    });
  });

  it("offers an admin no agent of their own while the company has them off", async () => {
    const fake = fakeConnections();
    await shown(fake, "new-own-off");
    await press(answer("Something else"));
    await set(answerBox(), "Chases unpaid invoices.", "input");
    await press(button("Next"));
    await set(answerBox(), "Claire", "input");
    await press(button("Next"));
    await press(button("Next"));
    await press(button("Next"));
    // Whom it is for: the company's people, never just the admin.
    expect(answer("Everyone in the company")).toBeInstanceOf(HTMLElement);
    expect(() => answer("Just for me")).toThrow("No answer Just for me");
  });

  it("asks an admin first who can use a new agent set up by hand, everyone as offered, and makes it for everyone", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    await shown(fake, "new-guided");
    const everyone = radio("Everyone");
    const offered =
      everyone instanceof HTMLInputElement
        ? String(everyone.checked)
        : everyone.getAttribute("aria-checked");
    const questions = await setUpByHand("Claire");
    await press(button("Make agent"));
    expect({ offered, questions }).toStrictEqual({
      offered: "true",
      questions: [
        "Who can use it?",
        "What should we call your agent?",
        "What should Claire do?",
        "How should Claire work?",
        "Which apps can Claire use?",
        "What can Claire do?",
        "How hard should Claire think?",
        "When should Claire work?",
        "Ready to make Claire?",
      ],
    });
    expect(asked[0]).toStrictEqual([
      "make",
      expect.objectContaining({ name: "Claire" }),
    ]);
    expect(asked).toContainEqual([
      "reach",
      "agent-1",
      true,
      { who: "everyone" },
    ]);
  });

  it("asks no more of an agent just for its maker, set up by hand, than it keeps, and makes it theirs", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    await shown(fake, "new-guided");
    await press(radio("Just me"));
    const questions = await setUpByHand("Claire");
    await press(button("Make agent"));
    expect({ questions, made: asked[0] }).toStrictEqual({
      // Never what it may do or when it works: one of their own has neither.
      questions: [
        "Who can use it?",
        "What should we call your agent?",
        "What should Claire do?",
        "How should Claire work?",
        "Which apps can Claire use?",
        "How hard should Claire think?",
        "Ready to make Claire?",
      ],
      made: ["make own", expect.objectContaining({ name: "Claire" })],
    });
    expect(
      asked.some(([what]) => what === "reach" || what === "wake")
    ).toBeFalsy();
  });

  it("never asks someone who isn't an admin who can use an agent they set up by hand", async () => {
    const fake = fakeConnections();
    await shown(fake, "new-guided", false);
    expect(document.querySelector("h1")?.textContent).toBe(
      "What should we call your agent?"
    );
  });

  it("lets an admin make an agent just for themselves instead of one for the company", async () => {
    const fake = fakeConnections();
    const { asked } = fake;
    await shown(fake, "new");
    // Just for me: never asked when it works on its own.
    await makeInChat({
      name: "Claire",
      instructions: claireTold,
      whose: "mine",
    });
    expect(asked).toStrictEqual([
      ["make own", expect.objectContaining({ name: "Claire" })],
      ["told", "agent-1", claireTold],
      ["work out", "agent-1"],
    ]);
  });

  it("shows a person's own agent as theirs alone, with no audience, classes or schedule to set, and saves what they change", async () => {
    const fake = fakeConnections();
    const { connections, asked } = fake;
    await connections.makeOwnAgent(claire);
    asked.length = 0;
    await shown(fake, { agent: "Claire" });
    const text = document.body.textContent;
    await press(await fromMenu("Edit"));
    await set(field("Name"), "Clara", "input");
    await press(dialogButton("Save"));
    await openTab("access");
    const access = choice("Who may use Clara");
    await openTab("schedule");
    expect({
      alone: text.includes("Just for you"),
      who: text.includes("Only you"),
      access,
      schedule: [...document.querySelectorAll("button")].some(
        (each) => inView(each) && each.textContent?.trim() === "Add a time"
      ),
      asked,
    }).toStrictEqual({
      alone: true,
      who: true,
      access: null,
      schedule: false,
      asked: [["change", "agent-1", { ...claire, name: "Clara" }]],
    });
  });

  it("offers a person's own agent to the company from its page, and takes the offer back", async () => {
    const fake = fakeConnections();
    const { connections, asked } = fake;
    await connections.makeOwnAgent(claire);
    asked.length = 0;
    await shown(fake, { agent: "Claire" });
    await press(settingSwitch("Offer to the company"));
    const offered = document.body.textContent.includes("Offered on");
    await press(settingSwitch("Offer to the company"));
    expect({ offered, asked }).toStrictEqual({
      offered: true,
      asked: [
        ["offer", "agent-1", true],
        ["offer", "agent-1", false],
      ],
    });
  });

  it("offers no company agent to the company", async () => {
    const fake = await withClaire();
    await shown(fake, { agent: "Claire" });
    expect(document.body.textContent).not.toContain("Offer to the company");
  });

  it("works its apps out from its instructions on a press and as they are saved, says what it turned on, and turns on what it suggests only on a press", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "instructions" });
    await press(button("Work out from its instructions"));
    const said = document.body.textContent;
    await press(button("Turn on"));
    await press(button("Take Google Workspace off"));
    await set(
      field("Instructions"),
      "Answer about HubSpot deals too.",
      "input"
    );
    await press(exactButton("Save"));
    expect({
      said: [
        said.includes("Added from its instructions: Google Workspace."),
        said.includes("Turned on, as it only reads: Read their own."),
        said.includes("doesn't offer: Slack."),
        said.includes("Claire also needs “Reach others”"),
      ],
      asked: asked.map((each) => each.slice(0, 4)),
    }).toStrictEqual({
      said: [true, true, true, true],
      asked: [
        ["work out", "agent-1"],
        ["class", "agent-1", "reach-others", { who: "asClass" }],
        ["app", "agent-1", "native:google", false],
        ["told", "agent-1", "Answer about HubSpot deals too."],
        ["work out", "agent-1"],
      ],
    });
  });

  it("suggests the apps its instructions point to, adds a connected one on a press, and leads to connecting one that isn't", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await fake.instructions.save({
      file: { scope: "agent", agentId: "agent-1" },
      change: "told-again",
      text: "Send each reminder by mail, and keep the deals in HubSpot.",
      after: 1,
    });
    await shown(fake, { agent: "Claire", tab: "instructions" });
    const connect = document.querySelector("a[aria-label='Connect HubSpot']");
    const before = asked.length;
    await press(button("Add Google Workspace"));
    expect({
      suggested: [
        document.body.textContent.includes(
          "Suggested for Claire: connect it first"
        ),
        connect?.getAttribute("href"),
      ],
      asked: asked.slice(before).map((each) => each.slice(0, 4)),
    }).toStrictEqual({
      suggested: [true, "/integrations/composio%3Ahubspot"],
      asked: [["app", "agent-1", "native:google", true]],
    });
  });

  it("asks an admin for an app its instructions name that the company doesn't offer, and adds the schedule they propose only on a press", async () => {
    const fake = await withClaire();
    const { asked } = fake;
    await shown(fake, { agent: "Claire", tab: "instructions" });
    await press(button("Work out from its instructions"));
    const said = document.body.textContent;
    const before = asked.length;
    await press(button("Ask for Slack"));
    await press(button("Add this schedule"));
    expect({
      said: said.includes("works on its own: 0 8 * * 1 · Sum up the week."),
      // Made: shown as one of its schedules, with no button to make it twice.
      made: [
        document.body.textContent.includes("Already one of its schedules."),
        [...document.querySelectorAll("button")].every(
          (each) => each.textContent?.trim() !== "Add this schedule"
        ),
      ],
      asked: asked.slice(before).map((each) => each.slice(0, 3)),
    }).toStrictEqual({
      said: true,
      made: [true, true],
      asked: [
        ["request app", "Slack"],
        [
          "wake",
          "agent-1",
          {
            cron: "0 8 * * 1",
            opening: "Sum up the week.",
            // The viewer isn't among the company's people: the first is.
            personId: "user-anna",
          },
        ],
      ],
    });
  });
});
