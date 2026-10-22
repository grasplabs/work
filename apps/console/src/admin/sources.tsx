import type {
  AdminSource,
  SourceFeeds,
  SourceReads,
} from "@grasp-os/shared/admin/admin-sources";
import { ADMIN_SOURCES } from "@grasp-os/shared/admin/admin-sources";
import { ADMIN_TOOLS, digestOf } from "@grasp-os/shared/admin/admin-tools";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { Badge } from "@grasp-os/ui/components/badge";

import { Panel } from "./parts.tsx";
import { formatList } from "./words.ts";

// The admin's Sources page, as the prototype has it (`routes/admin/
// sources.tsx` and `components/admin/source-words.ts` at 740f40f): the
// admin's own MCP first, which every chat about Grasp's companies goes
// through, then the morning digest as Discord will post it, then every
// system it reads, in the order they come. Each is reached through its own
// MCP server, so what is typed by hand now fills in by itself.

/** Each source's name. */
const names: Record<AdminSource["id"], string> = {
  grasp: "Grasp admin",
  console: "Grasp console",
  rooms: "Rooms",
  attio: "Attio",
  stripe: "Stripe",
  composio: "Composio",
  discord: "Discord",
};

/** What each source is, in one line. */
const abouts: Record<AdminSource["id"], string> = {
  grasp:
    "The admin as tools, for any chat: Grasp’s own here, Claude, ChatGPT, or a bot in Discord. It only reads.",
  console:
    "Deploys each company’s own Grasp into its own Cloudflare account, and rolls out every release.",
  rooms:
    "Where Grasp writes its proposals and the company signs them: the contract follows from what was signed.",
  attio:
    "The CRM. Every call with a company is there, with who was in it, so the people Grasp deals with are never typed twice.",
  stripe:
    "Billing: what each company pays, its invoices and whether they are paid.",
  composio:
    "What each company connected, and what its workflows still need connected.",
  discord:
    "Grasp’s own server: the morning digest in a channel, and questions to the admin from there.",
};

/** What a source holds that the admin reads. */
const readWords: Record<SourceReads, string> = {
  organizations: "organizations",
  briefs: "briefs for the next call",
  needs: "what needs Grasp",
  deployments: "deployments",
  releases: "releases",
  proposals: "proposals",
  signatures: "signatures",
  companies: "companies",
  people: "people",
  calls: "calls",
  customers: "customers",
  subscriptions: "subscriptions",
  invoices: "invoices",
  connections: "connections",
  toolkits: "apps to connect",
  digest: "the morning digest",
  questions: "questions",
};

/** The places in the admin a source fills. */
const feedWords: Record<SourceFeeds, string> = {
  portfolio: "Overview",
  ask: "Ask Grasp",
  details: "Details",
  contract: "Contract",
  invoices: "Invoices",
  members: "Members",
  setup: "Setup",
  integrations: "Integrations",
  workflows: "Workflows",
  usage: "AI use",
  log: "Log",
};

/** Connected, or still to come. */
const StateBadge = ({ state }: { state: AdminSource["state"] }) =>
  state === "live" ? (
    <Badge variant="secondary">Connected</Badge>
  ) : (
    <Badge variant="outline">To come</Badge>
  );

/**
 * The admin's own MCP: what a chat can ask it. Until the console serves it
 * (GRA-656) it has no address to copy, so it says so instead.
 */
const OwnSource = ({ source }: { source: AdminSource }) => (
  <Panel
    action={<StateBadge state={source.state} />}
    description={abouts[source.id]}
    title={names[source.id]}
  >
    <div className="flex flex-col gap-4 border-t px-5 py-4">
      {source.state === "live" ? null : (
        <p className="text-muted-foreground text-xs">
          Its address, for Claude or ChatGPT as a custom connector, comes once
          the console serves it. Whoever connects it will sign in as someone at
          Grasp.
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">
          What a chat can ask it. It only reads: whatever changes a company
          stays a button here.
        </span>
        <ul className="flex flex-col gap-2">
          {ADMIN_TOOLS.map((tool) => (
            <li className="flex flex-col gap-0.5" key={tool.name}>
              <code className="font-mono text-xs">{tool.name}</code>
              <span className="text-muted-foreground text-xs">
                {tool.description}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </Panel>
);

/** One system the admin reads or is read by: what it brings, what it fills, and its tools. */
const SourceRow = ({ source }: { source: AdminSource }) => {
  const brings = formatList(source.reads.map((each) => readWords[each]));
  const fills = formatList(source.feeds.map((each) => feedWords[each]));
  return (
    <li className="flex flex-col gap-1.5 border-t px-5 py-4">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{names[source.id]}</span>
        <StateBadge state={source.state} />
      </span>
      <span className="text-muted-foreground">{abouts[source.id]}</span>
      <span className="text-muted-foreground text-xs">
        {source.direction === "in"
          ? `Brings ${brings}. Fills ${fills}.`
          : `Gets ${brings} from the admin, for ${fills}.`}
      </span>
      {source.tools.length > 0 ? (
        <span className="flex flex-wrap gap-1.5">
          {source.tools.map((tool) => (
            <code
              className="bg-muted rounded-md border px-1.5 py-0.5 font-mono text-xs"
              key={tool}
            >
              {tool}
            </code>
          ))}
        </span>
      ) : null}
    </li>
  );
};

/** The Sources page's three parts, for the organizations that answered, on `today` (YYYY-MM-DD). */
export const Sources = ({
  views,
  today,
}: {
  views: readonly AdminView[];
  today: string;
}) => {
  const own = ADMIN_SOURCES.filter((source) => source.id === "grasp");
  const others = ADMIN_SOURCES.filter(
    (source) => source.id !== "grasp"
  ).toSorted((a, b) => a.order - b.order);
  return (
    <>
      {own.map((source) => (
        <OwnSource key={source.id} source={source} />
      ))}
      <Panel
        action={<Badge variant="outline">Discord</Badge>}
        description="What Grasp’s bot posts in Discord every morning, once it is connected: today’s, from the organizations as they stand."
        title="The morning digest"
      >
        <div className="border-t px-5 py-4">
          <p className="bg-muted rounded-lg px-4 py-3 text-sm whitespace-pre-wrap">
            {digestOf(views, today)}
          </p>
        </div>
      </Panel>
      <Panel
        description="Until a system is connected, what it would bring is typed in the admin by hand. The one that saves the most typing comes first."
        title="To connect, in this order"
      >
        <ol className="flex flex-col">
          {others.map((source) => (
            <SourceRow key={source.id} source={source} />
          ))}
        </ol>
      </Panel>
    </>
  );
};
