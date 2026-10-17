/**
 * Where Grasp's admin gets what it knows about a company, and where what it knows goes. Every
 * outside system is reached through its own MCP server, the same way an AI app reaches Grasp, so
 * one chat (Grasp's own, Claude, ChatGPT, a Discord bot) can work across all of them; the admin
 * then fills in by itself what is now typed by hand. Which ones are connected is `state`: the rest
 * is the plan, in the order they come. Pure data.
 */

/** A place in the admin a source fills: the list of every organization, the chat, or a section of one. */
export type SourceFeeds =
  | "portfolio"
  | "ask"
  | "details"
  | "contract"
  | "invoices"
  | "members"
  | "setup"
  | "integrations"
  | "workflows"
  | "usage"
  | "log";

/** What a source holds that the admin reads, in plain words the page says. */
export type SourceReads =
  | "organizations"
  | "briefs"
  | "needs"
  | "deployments"
  | "releases"
  | "proposals"
  | "signatures"
  | "companies"
  | "people"
  | "calls"
  | "customers"
  | "subscriptions"
  | "invoices"
  | "connections"
  | "toolkits"
  | "digest"
  | "questions";

export interface AdminSource {
  id:
    | "grasp"
    | "console"
    | "rooms"
    | "attio"
    | "stripe"
    | "composio"
    | "discord";
  /** Grasp's own systems, or another company's. */
  ours: boolean;
  /** Connected and read now, or still to connect. */
  state: "live" | "planned";
  /** The order the planned ones come in: the one that saves the most typing first. */
  order: number;
  /** Which way round: the admin reads from it, or it reads from the admin (a chat in Discord asks the admin). */
  direction: "in" | "out";
  reads: SourceReads[];
  feeds: SourceFeeds[];
  /** The MCP tools the admin calls there, where they are known: only reading ones, unless a person presses a button. */
  tools: string[];
}

export const ADMIN_SOURCES: readonly AdminSource[] = [
  {
    // The admin's own MCP: what every chat about Grasp's companies asks.
    id: "grasp",
    ours: true,
    state: "live",
    order: 0,
    direction: "out",
    reads: ["organizations", "briefs", "needs", "digest"],
    feeds: ["ask", "portfolio"],
    tools: [],
  },
  {
    // Each company's own platform, deployed into its own Cloudflare account by the console.
    id: "console",
    ours: true,
    state: "planned",
    order: 1,
    direction: "in",
    reads: ["deployments", "releases"],
    feeds: ["setup", "portfolio"],
    tools: [],
  },
  {
    // Where Grasp writes its proposals and the company signs them.
    id: "rooms",
    ours: true,
    state: "planned",
    order: 2,
    direction: "in",
    reads: ["proposals", "signatures"],
    feeds: ["contract", "log"],
    tools: [
      "list_projects",
      "get_project",
      "get_content",
      "get_signature_requests",
      "get_signature_receipt",
    ],
  },
  {
    // The CRM: every call with a company is there, with who was in it.
    id: "attio",
    ours: false,
    state: "planned",
    order: 3,
    direction: "in",
    reads: ["companies", "people", "calls"],
    feeds: ["details", "portfolio", "log"],
    tools: [],
  },
  {
    id: "stripe",
    ours: false,
    state: "planned",
    order: 4,
    direction: "in",
    reads: ["customers", "subscriptions", "invoices"],
    feeds: ["invoices", "contract", "portfolio"],
    tools: [],
  },
  {
    // What each company connected through Composio, and what its workflows still ask for.
    id: "composio",
    ours: false,
    state: "planned",
    order: 5,
    direction: "in",
    reads: ["connections", "toolkits"],
    feeds: ["integrations", "workflows"],
    tools: [],
  },
  {
    // Grasp's own server: a bot that posts the morning digest and answers questions through the admin's MCP.
    id: "discord",
    ours: false,
    state: "planned",
    order: 6,
    direction: "out",
    reads: ["digest", "questions"],
    feeds: ["ask"],
    tools: [],
  },
];
