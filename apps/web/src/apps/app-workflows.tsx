import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import type {
  AppWorkflowBinding,
  WorkflowResource,
} from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import { useDraft } from "../drafts/use-draft.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// The workflows an App starts, on the App's Resources tab, for its
// builders (`workflowResources.appBindings`, which core lets them read
// and nobody else, never Grasp staff): each alias the App's code starts a
// workflow by, whose live version it starts. A binding is part of the
// App's version: a builder changes what an alias binds in the App's
// draft (`apps.define` with `bindWorkflow`, to a workflow they have a
// role in), which declares what the App relies on of its live version
// and binds it once they publish the draft; the chat does the same, and
// ends a binding by publishing a version that no longer binds it. A
// binding grants nothing: starting through it still takes the App's own
// permission on the workflow, which an admin grants. An archived App's
// bindings are kept and shown, but not changed.

/** The workflows the person has a role in, with a published version. */
const bindable = (workflows: readonly WorkflowResource[]): WorkflowResource[] =>
  workflows.filter((workflow) => workflow.currentVersion !== null);

/**
 * Changing which workflow an alias binds, in the App's draft, over
 * `revision`, the draft's as the page read it last (core refuses one the
 * draft moved past); undefined until it is read.
 */
const BindDialog = ({
  app,
  revision,
  binding,
  workflows,
  onClose,
  onDrafted,
}: {
  app: string;
  revision: number | undefined;
  /** The binding it changes. */
  binding: AppWorkflowBinding;
  workflows: readonly WorkflowResource[];
  onClose: () => void;
  onDrafted: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [problem, setProblem] = useState<string>();
  const [workflow, setWorkflow] = useState<string | null>(
    workflows.some((each) => each.id === binding.workflowId)
      ? binding.workflowId
      : null
  );
  const workflowId = useId();
  const { alias } = binding;
  const bind = async (): Promise<void> => {
    if (workflow === null || revision === undefined) {
      return;
    }
    setProblem(undefined);
    const changed = await run(
      async (session) =>
        await session.apps.define(app, revision, {
          op: "bindWorkflow",
          alias,
          workflow,
        })
    );
    if (changed === undefined) {
      return;
    }
    if (!changed.ok) {
      setProblem(changed.problem);
      return;
    }
    onDrafted();
    onClose();
  };
  const workflowItems = workflows.map((each) => ({
    value: each.id,
    label: each.name,
  }));
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Change what {alias} starts</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The change goes into the App&apos;s draft, which declares what the
              workflow&apos;s live version has. Once you publish the draft, the
              App starts that workflow&apos;s live version by this name.
              Starting it still takes the App&apos;s own permission on the
              workflow, which an admin grants.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={workflowId}>
            <Trans>Workflow</Trans>
          </FieldLabel>
          <Select
            items={workflowItems}
            onValueChange={(value: unknown) => {
              if (typeof value === "string") {
                setWorkflow(value);
              }
            }}
            value={workflow}
          >
            <SelectTrigger className="w-full" id={workflowId}>
              <SelectValue placeholder={t`Choose a workflow`} />
            </SelectTrigger>
            <SelectContent>
              {workflowItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <ErrorText>{failure ?? problem}</ErrorText>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy || workflow === null || revision === undefined}
            onClick={() => {
              void bind();
            }}
          >
            <Trans>Change in the draft</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The bindings as read, with changing one in the draft for who may. */
const BindingsView = ({
  app,
  revision,
  bindings,
  workflows,
  changes,
}: {
  app: string;
  /** The draft's revision as read last; undefined until it is. */
  revision: number | undefined;
  bindings: readonly AppWorkflowBinding[];
  workflows: readonly WorkflowResource[];
  /** Whether the person may change them: not on an archived App. */
  changes: boolean;
}) => {
  const [binding, setBinding] = useState<AppWorkflowBinding | null>(null);
  const [drafted, setDrafted] = useState(false);
  const names = new Map(workflows.map((each) => [each.id, each.name]));
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">
        <Trans>Workflows the App starts</Trans>
      </h2>
      {drafted ? (
        <p className="text-muted-foreground">
          <Trans>
            Changed in the draft: publish the App for it to start the new
            workflow.
          </Trans>
        </p>
      ) : null}
      {bindings.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>The App starts no workflow of its own.</Trans>
        </p>
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">
                  <Trans>Name in the App&apos;s code</Trans>
                </TableHead>
                <TableHead variant="card">
                  <Trans>Workflow</Trans>
                </TableHead>
                <TableHead className="w-44" variant="card">
                  <Trans>Bound</Trans>
                </TableHead>
                {changes ? (
                  <TableHead className="w-24" variant="card">
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.map((each) => (
                <TableRow key={each.id}>
                  <TableCell variant="card">
                    <span className="font-mono text-xs">{each.alias}</span>
                  </TableCell>
                  <TableCell variant="card">
                    {names.get(each.workflowId) ?? (
                      <span className="font-mono text-xs">
                        {each.workflowId}
                      </span>
                    )}
                  </TableCell>
                  <TableCell variant="card">
                    {formatDateTime(each.boundAt)}
                  </TableCell>
                  {changes ? (
                    <TableCell variant="card">
                      <div className="flex justify-end">
                        <Button
                          onClick={() => {
                            setBinding(each);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          <Trans>Change</Trans>
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {binding === null ? null : (
        <BindDialog
          app={app}
          binding={binding}
          revision={revision}
          onClose={() => {
            setBinding(null);
          }}
          onDrafted={() => {
            setDrafted(true);
          }}
          workflows={bindable(workflows)}
        />
      )}
    </section>
  );
};

/** What the section reads: the App's bindings, and the workflows to name them by. */
interface Read {
  bindings: AppWorkflowBinding[];
  workflows: WorkflowResource[];
}

/**
 * The workflows an App binds, for its builders, read when the Resources
 * tab opens.
 */
export const AppWorkflows = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "staff">;
}) => {
  const core = useCore();
  const builds = buildsApp(app, identity);
  // The draft a change goes into, followed as builders write it.
  const { draft } = useDraft(
    builds ? { kind: "app", id: app.id } : undefined,
    0
  );
  const [read, setRead] = useState<Loaded<Read>>();
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      if (!builds) {
        return;
      }
      const loaded = await loadFromCore(
        core,
        async (session) => {
          const [bindings, workflows] = await Promise.all([
            session.workflowResources.appBindings(app.id),
            session.workflowResources.list(),
          ]);
          return { bindings, workflows };
        },
        left.signal
      );
      if (!left.signal.aborted) {
        setRead(loaded);
      }
    };
    void load();
    return () => {
      left.abort();
    };
  }, [app.id, builds, core]);
  if (!builds) {
    return null;
  }
  if (read === undefined) {
    return <LoadingLines lines={2} />;
  }
  if (read.state !== "ready") {
    return <NotLoaded page={read} />;
  }
  return (
    <BindingsView
      app={app.id}
      bindings={read.data.bindings}
      changes={!app.archived}
      revision={draft?.revision}
      workflows={read.data.workflows}
    />
  );
};
