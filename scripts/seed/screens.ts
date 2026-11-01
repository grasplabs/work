/**
 * The demo domains' apps (core's screens): a screen per domain that starts
 * a run of one of the workflows its App binds and follows it, as the
 * typed screen SDK does (`useWorkflow(workflows.x)`). Decisions are
 * answered in the inbox and on the decision page, and a workflow's runs
 * are in its overview and activity: a screen sees only the runs it
 * starts. Each reads nothing else: no permission, no connection.
 */
import { engines } from "./engines.ts";
import type { WorkflowSeed } from "./engines.ts";

/** A component's name for workflow alias `alias`: `mortgageFiles` → `MortgageFiles`. */
const componentOf = (alias: string): string =>
  `${alias.charAt(0).toUpperCase()}${alias.slice(1)}Run`;

/**
 * A screen with a card for each workflow in `workflows`: a button that
 * starts a run of it with its sample input, and the run as it goes on.
 */
const domainScreen = ({
  title,
  intro,
  workflows,
}: {
  title: string;
  intro: string;
  workflows: readonly WorkflowSeed[];
}): string => `import { useWorkflow } from "@grasp-os/sdk/react";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { useState } from "react";

import { workflows } from "#grasp";

/** What a run is doing, in words, from its status. */
const statusLabels: Record<string, string> = {
  idle: "Starting",
  loading: "Starting",
  queued: "Waiting its turn",
  running: "Running",
  waiting: "Waiting for a decision: answer it in your inbox",
  paused: "Paused",
  compensating: "Undoing what it did",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
${workflows
  .map(
    ({ alias }) => `
const ${componentOf(alias)} = ({ runId }: { runId: string }) => {
  const run = useWorkflow(workflows.${alias}, { runId });
  return (
    <div className="flex flex-col gap-2">
      <Badge variant="secondary">{statusLabels[run.status] ?? run.status}</Badge>
      {run.status === "completed" ? (
        <pre className="text-sm whitespace-pre-wrap">{JSON.stringify(run.output, null, 2)}</pre>
      ) : null}
      {run.status === "failed" ? <p className="text-sm text-destructive">{run.error.message}</p> : null}
    </div>
  );
};`
  )
  .join("\n")}

export default function Screen() {
  const [problem, setProblem] = useState("");
${workflows
  .map(
    ({ alias }) => `  const ${alias} = useWorkflow(workflows.${alias});
  const [${alias}Run, set${componentOf(alias)}] = useState<string | null>(null);`
  )
  .join("\n")}
  return (
    <main className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">${title}</h1>
        <p className="text-muted-foreground">${intro}</p>
      </header>
      {problem === "" ? null : <p className="text-sm text-destructive">{problem}</p>}
${workflows
  .map(
    ({ alias, title: name, sample }) => `      <Card>
        <CardHeader>
          <CardTitle>${name}</CardTitle>
          <CardDescription>Starts a run on a sample and follows it.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
          <Button
            className="self-start"
            onClick={async () => {
              setProblem("");
              try {
                const { runId } = await ${alias}.run(${JSON.stringify(sample)});
                set${componentOf(alias)}(runId);
              } catch (error) {
                setProblem(error instanceof Error ? error.message : "That didn't start.");
              }
            }}
          >
            Try it on a sample
          </Button>
          {${alias}Run === null ? null : <${componentOf(alias)} runId={${alias}Run} />}
          </div>
        </CardContent>
      </Card>`
  )
  .join("\n")}
    </main>
  );
}
`;

/** The screen of each domain that has one: its file's name, title and intro. */
const domainScreens: Record<
  string,
  { name: string; title: string; intro: string }
> = {
  "Purchase-to-Pay": {
    name: "finance-cockpit",
    title: "Finance cockpit",
    intro:
      "Try the invoice workflow on a sample. Approvals wait in the approvers' inbox.",
  },
  "Issue-to-Resolution": {
    name: "service-desk",
    title: "Service desk",
    intro:
      "Try the service desk's workflows on a sample. Compensation to approve waits in compliance's inbox.",
  },
  "Opportunity-to-Cash": {
    name: "advice-pipeline",
    title: "My advice pipeline",
    intro:
      "Try the onboarding and handover workflows on a sample. Files to take over wait in the advisers' inbox.",
  },
};

/**
 * The screens of each domain, by domain name, then by screen name: the
 * prototype's apps (`apps` in noordkade.ts), each over the workflows of
 * its domain, since a screen starts only its own App's. The prototype's
 * charts of revenue, tickets and leads read systems no connection brings
 * yet, and its run histories are the workflows' own pages now.
 */
export const engineScreens: Record<
  string,
  Record<string, string>
> = Object.fromEntries(
  engines.flatMap(({ name, workflows }) => {
    const screen = domainScreens[name];
    return screen === undefined
      ? []
      : [
          [
            name,
            {
              [screen.name]: domainScreen({
                title: screen.title,
                intro: screen.intro,
                workflows,
              }),
            },
          ],
        ];
  })
);

/**
 * The domains whose screens an admin approves as the seed runs; the
 * others' wait for an admin, so the dashboard shows one to approve.
 */
export const approvedScreens: ReadonlySet<string> = new Set([
  "Purchase-to-Pay",
  "Opportunity-to-Cash",
]);
