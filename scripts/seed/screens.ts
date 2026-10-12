/**
 * The demo engines' apps (core's screens): views their teams work from,
 * over the engine's own workflow runs, so the Engines page has apps to
 * open and admins have a screen to approve. Each reads only what the
 * screen SDK gives any screen of its App (`useWorkflow`): no permission,
 * no connection.
 */

/**
 * A screen that follows one workflow's runs: how many ended how over
 * the last 30 days, the decisions waiting with their answers, and the
 * latest runs. `title` and `intro` name what it's for.
 */
const workflowScreen = ({
  name,
  workflow,
  title,
  intro,
  waitingTitle,
}: {
  name: string;
  workflow: string;
  title: string;
  intro: string;
  waitingTitle: string;
}): string => `import { useWorkflow } from "@grasp-os/sdk/screen";
import type { ScreenRun } from "@grasp-os/sdk/screen";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@grasp-os/ui/components/table";
import { useState } from "react";

const dayMs = 24 * 60 * 60 * 1000;

const statusLabels: Record<ScreenRun["status"], string> = {
  running: "Running",
  waiting: "Waiting for a decision",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** How many of \`runs\` started in the last 30 days ended as \`status\`. */
const countOf = (runs: ScreenRun[], status: ScreenRun["status"]): number =>
  runs.filter((run) => run.status === status && Date.now() - Date.parse(run.createdAt) < 30 * dayMs).length;

const Waiting = ({ run, decide }: { run: ScreenRun; decide: (approved: boolean) => Promise<void> }) => {
  const [problem, setProblem] = useState("");
  const answer = async (approved: boolean) => {
    setProblem("");
    try {
      await decide(approved);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That didn't work.");
    }
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b py-2 last:border-b-0">
      <span className="flex flex-col">
        <span>{run.waitingFor[0]?.description ?? "A decision"}</span>
        <span className="text-muted-foreground text-sm">Since {day(run.createdAt)}</span>
        {problem === "" ? null : <span className="text-destructive text-sm">{problem}</span>}
      </span>
      <span className="flex gap-2">
        <Button onClick={() => void answer(true)} size="sm">Approve</Button>
        <Button onClick={() => void answer(false)} size="sm" variant="outline">Reject</Button>
      </span>
    </li>
  );
};

export default function ${name}() {
  const { runs, decide } = useWorkflow(${JSON.stringify(workflow)});
  const waiting = runs.filter((run) => run.waitingFor.length > 0);
  const numbers = [
    { label: "Completed", value: countOf(runs, "completed") },
    { label: "Failed", value: countOf(runs, "failed") },
    { label: "Waiting", value: waiting.length },
  ];
  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">${title}</h1>
        <p className="text-muted-foreground">${intro}</p>
      </header>
      <div className="grid grid-cols-3 gap-4">
        {numbers.map(({ label, value }) => (
          <Card key={label}>
            <CardHeader>
              <CardDescription>{label}, last 30 days</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-medium">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>${waitingTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {waiting.length === 0 ? (
            <p className="text-muted-foreground">Nothing waits for a decision.</p>
          ) : (
            <ul>
              {waiting.map((run) => (
                <Waiting
                  decide={async (approved) => {
                    const name = run.waitingFor[0]?.name;
                    if (name !== undefined) {
                      await decide(run.id, name, { approved });
                    }
                  }}
                  key={run.id}
                  run={run}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Latest runs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ended</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.slice(0, 15).map((run) => (
                <TableRow key={run.id}>
                  <TableCell>{day(run.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{statusLabels[run.status]}</Badge>
                  </TableCell>
                  <TableCell>{run.endedAt === null ? "" : day(run.endedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
`;

/** The screens of each engine, by engine name, then by screen name. */
export const engineScreens: Record<string, Record<string, string>> = {
  Finance: {
    "invoice-approvals": workflowScreen({
      name: "InvoiceApprovals",
      workflow: "supplier-invoices",
      title: "Invoice approvals",
      intro:
        "Supplier invoices above the limit, waiting for finance, and how the last month went.",
      waitingTitle: "Waiting for your approval",
    }),
  },
  "Service desk": {
    complaints: workflowScreen({
      name: "Complaints",
      workflow: "complaint-acknowledgement",
      title: "Complaints",
      intro:
        "Every complaint registered, and the compensation waiting for compliance.",
      waitingTitle: "Compensation to approve",
    }),
  },
  "Client onboarding": {
    handovers: workflowScreen({
      name: "Handovers",
      workflow: "file-handover",
      title: "File handovers",
      intro: "Complete client files waiting for an adviser to take them over.",
      waitingTitle: "Files to take over",
    }),
  },
};

/**
 * The engines whose screens an admin approves as the seed runs; the
 * others' wait for an admin, so the dashboard shows one to approve.
 */
export const approvedScreens: ReadonlySet<string> = new Set([
  "Finance",
  "Client onboarding",
]);
