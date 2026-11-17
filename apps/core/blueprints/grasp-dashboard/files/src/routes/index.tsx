import type { Id } from "@grasp-os/sdk";
import { useAction, useForm, useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Grid } from "@grasp-os/ui/components/grid";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Stat } from "@grasp-os/ui/components/stat";
import { Form, FormError, SubmitButton, TextField } from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

// The company's dashboard as an App: a set of cards, drawn from what an
// App reads of the platform today (`grasp.statistics.read`). A company
// changes this page by asking Grasp.

interface Group {
  name: string;
  count: number;
}

interface Figures {
  runs: Group[];
  signals: Group[];
  leftOut: string[];
}

/** What the signals' kinds are called. */
const kindNames: Record<string, string> = {
  waiting_for_person: "Waiting for someone",
  failing_step: "A step that fails",
  correction: "Corrected by hand",
  cost_per_run: "Cost per run",
  unanswered_question: "Unanswered questions",
};

const total = (groups: Group[]): number =>
  groups.reduce((sum, { count }) => sum + count, 0);

/** A card of counts: their total, and each by its name. */
const Counts = ({
  title,
  groups,
  none,
}: {
  title: string;
  groups: Group[] | undefined;
  none: string;
}) => (
  <Card size="sm">
    <CardHeader>
      <CardDescription>{title}</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-3">
        {groups === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <Stat>{String(total(groups))}</Stat>
            {groups.length === 0 ? (
              <p className="text-muted-foreground text-sm">{none}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {groups.map(({ name, count }) => (
                  <li className="flex justify-between gap-3" key={name}>
                    <span>{kindNames[name] ?? name}</span>
                    <span className="tabular-nums">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </CardContent>
  </Card>
);

/** Counts one more App, in a dialog: builders only, as the store checks. */
const CountApp = () => {
  const [open, setOpen] = useState(false);
  const form = useForm(api.dashboard.count, {
    defaultValues: { appId: "", title: "" },
    resetOnSuccess: true,
    onSuccess: () => {
      setOpen(false);
    },
  });
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button variant="outline" />}>
        Count an App
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Count an App</DialogTitle>
          <DialogDescription>
            An App can't list the company's Apps yet, so you name them.
          </DialogDescription>
        </DialogHeader>
        <Form aria-label="Count an App" form={form}>
          <TextField form={form} label="Name" name="title" />
          <TextField
            form={form}
            label="App ID, from its address"
            name="appId"
          />
          <FormError form={form} />
          <SubmitButton form={form}>Count it</SubmitButton>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

/** The Apps it counts, each to stop counting. */
const Counted = ({ apps }: { apps: { id: Id<"apps">; title: string }[] }) => {
  const forget = useMutation(api.dashboard.forget);
  return (
    <ul aria-label="Apps counted" className="flex flex-wrap gap-2">
      {apps.map((app) => (
        <li key={app.id}>
          <Button
            aria-label={`Stop counting ${app.title}`}
            onClick={async () => {
              await forget({ id: app.id });
            }}
            size="sm"
            variant="outline"
          >
            {`${app.title} ×`}
          </Button>
        </li>
      ))}
    </ul>
  );
};

const Dashboard = () => {
  const read = useAction(api.dashboard.figures);
  const apps = useQuery(api.dashboard.counted, {});
  const [figures, setFigures] = useState<Figures>();
  const [failure, setFailure] = useState<string>();
  // Read again whenever the Apps counted change.
  useEffect(() => {
    if (apps === undefined) {
      return;
    }
    let current = true;
    read({})
      .then((answer) => {
        if (current) {
          setFigures(answer);
          setFailure(undefined);
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      current = false;
    };
  }, [apps, read]);
  return (
    <main className="flex flex-col gap-6 p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Dashboard</PageHeaderTitle>
        </PageHeaderContent>
        <PageHeaderActions>
          <CountApp />
        </PageHeaderActions>
      </PageHeader>
      <Counted apps={apps ?? []} />
      {failure === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
      <Grid columns={2}>
        <Counts
          groups={figures?.runs}
          none="No runs in the last 30 days."
          title="Runs, last 30 days"
        />
        <Counts
          groups={figures?.signals}
          none="Nothing to improve found."
          title="Where workflows lose time"
        />
      </Grid>
      {figures !== undefined && figures.leftOut.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          {`Not counted, as you may not see their runs: ${figures.leftOut.join(", ")}.`}
        </p>
      ) : null}
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Dashboard });
