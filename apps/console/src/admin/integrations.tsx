/**
 * Integrations to build, ported from the prototype (grasplabs/prototype
 * `routes/admin/integrations.tsx`): the apps the companies' workflows need
 * that Composio does not have, for every organization at once. Grasp
 * builds each into the platform itself, once, for every company that asked.
 *
 * Nothing records a build yet (that is the build itself, with Grasp's
 * agent), so where the prototype's table stands the page says there is
 * nothing to build. The table, a build's sheet and the buttons that move a
 * build on come with the record that feeds them.
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { HammerIcon } from "lucide-react";

import { AdminPage } from "./page.tsx";
import { Panel } from "./panel.tsx";

/** How a build goes, in plain words, and where people at Grasp stay in it. */
const buildSteps = [
  "A company’s workflow needs an app Composio does not have. It lands here once, however many companies ask for it.",
  "Build it starts Grasp’s agent on a branch of its own. It reads the app’s docs and writes a plan, which a person at Grasp approves.",
  "A person registers Grasp with the app and puts the keys in the console. The agent works against a stand-in for the app: it never sees a company’s data or production secrets.",
  "The agent writes the connection and its tests, runs them, has a second agent review the work, and opens a pull request. Nick or Jakob reviews it and merges it.",
  "The merge goes into the next release, which reaches the companies ring by ring as a person approves each. Then every company that asked connects the app like any other.",
] as const;

/** Where the table of builds goes, while there is none. */
const NothingToBuild = () => (
  <section className="bg-card rounded-xl border">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HammerIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing to build yet</EmptyTitle>
        <EmptyDescription>
          When a company’s workflow needs an app Composio does not have, it
          shows here, with who asked for it and where its build stands.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </section>
);

/**
 * How it is built, as the prototype says it. Its note that the platform
 * first needs sign-in with OAuth2 and with an API key is left out: connect
 * has both now, so every new app is one package and one record.
 */
const HowItIsBuilt = () => (
  <Panel
    description="Grasp’s agent does the writing; people at Grasp approve the plan, add the keys, review the code and approve the rollout."
    title="How it is built"
  >
    <ol className="flex flex-col">
      {buildSteps.map((step, index) => (
        <li className="flex gap-3 border-t px-5 py-3" key={step}>
          <span className="text-muted-foreground w-4 flex-none tabular-nums">
            {index + 1}
          </span>
          <span className="min-w-0 text-pretty">{step}</span>
        </li>
      ))}
    </ol>
  </Panel>
);

/** The page: what it is for, the builds (none yet), and how one is built. */
export const IntegrationsToBuild = () => (
  <AdminPage
    description="Apps the companies’ workflows need that Composio does not have. Grasp builds each into the platform itself, once, for every company that asked."
    title="Integrations to build"
  >
    <div className="flex flex-col gap-6 text-sm">
      <NothingToBuild />
      <HowItIsBuilt />
    </div>
  </AdminPage>
);
