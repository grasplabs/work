import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { appWorkflowBindingSchema } from "@grasp-os/shared/workflow-resources";
import type {
  AppWorkflowBinding,
  WorkflowResource,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
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

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// The workflows a domain's App starts, on the domain's Resources tab, for
// its builders (`workflowResources.appBindings`, which core lets them read
// and nobody else, never Grasp staff): each alias the App's code starts a
// workflow by, and the exact version it binds. Its builders bind an alias
// to a version of a workflow they have a role in (`bindToApp`), which
// replaces what the alias bound before, and remove a binding
// (`unbindFromApp`), once confirmed. A binding grants nothing: starting
// through it still takes the App's own permission on the workflow, which
// an admin grants. An archived App's bindings are kept and shown, but not
// changed.

/** What a binding binds, as the dialog was given it or chose it. */
interface Binding {
  alias: string;
  workflow: string | null;
  version: number | null;
}

/** The workflows the person has a role in, with a published version. */
const bindable = (workflows: readonly WorkflowResource[]): WorkflowResource[] =>
  workflows.filter((workflow) => workflow.currentVersion !== null);

/** Binding an alias to a workflow version, or changing what it binds. */
const BindDialog = ({
  app,
  start,
  workflows,
  onClose,
  onBound,
}: {
  app: string;
  /** What it starts from: an alias already bound, or a new one. */
  start: Binding;
  workflows: readonly WorkflowResource[];
  onClose: () => void;
  onBound: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const [alias, setAlias] = useState(start.alias);
  const [workflow, setWorkflow] = useState(start.workflow);
  const [chosen, setChosen] = useState(start.version);
  const [versions, setVersions] = useState<Loaded<WorkflowResourceVersion[]>>();
  const aliasId = useId();
  const workflowId = useId();
  const versionId = useId();
  const naming = start.alias === "";
  const aliasValid =
    appWorkflowBindingSchema.shape.alias.safeParse(alias).success;
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      if (workflow === null) {
        return;
      }
      const loaded = await loadFromCore(
        core,
        async (session) => await session.workflowResources.versions(workflow),
        left.signal
      );
      if (!left.signal.aborted) {
        setVersions(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core, workflow]);
  const published =
    versions?.state === "ready"
      ? versions.data.map((each) => each.version).toSorted((a, b) => b - a)
      : [];
  const bind = async (): Promise<void> => {
    if (workflow === null || chosen === null) {
      return;
    }
    const bound = await run(
      async (session) =>
        await session.workflowResources.bindToApp(workflow, {
          app,
          alias,
          version: chosen,
        })
    );
    if (bound !== undefined) {
      onBound();
      onClose();
    }
  };
  const workflowItems = workflows.map((each) => ({
    value: each.id,
    label: each.name,
  }));
  const versionItems = published.map((version) => ({
    value: version,
    label: t`Version ${version}`,
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
            {naming ? (
              <Trans>Bind a workflow</Trans>
            ) : (
              <Trans>Change what {alias} starts</Trans>
            )}
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The app starts this exact version by its name, until a builder
              binds another. Starting it still takes the app&apos;s own
              permission on the workflow, which an admin grants.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        {naming ? (
          <Field>
            <FieldLabel htmlFor={aliasId}>
              <Trans>Name in the app&apos;s code</Trans>
            </FieldLabel>
            <Input
              id={aliasId}
              maxLength={64}
              onChange={(event) => {
                setAlias(event.target.value);
              }}
              value={alias}
            />
            {alias === "" || aliasValid ? (
              <FieldDescription>
                <Trans>
                  A letter, then letters, digits or underscores, such as
                  summary.
                </Trans>
              </FieldDescription>
            ) : (
              <FieldError>
                <Trans>
                  Start with a letter, then use only letters, digits or
                  underscores.
                </Trans>
              </FieldError>
            )}
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor={workflowId}>
            <Trans>Workflow</Trans>
          </FieldLabel>
          <Select
            items={workflowItems}
            onValueChange={(value: unknown) => {
              if (typeof value === "string") {
                setWorkflow(value);
                setChosen(null);
                setVersions(undefined);
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
        <Field>
          <FieldLabel htmlFor={versionId}>
            <Trans>Version</Trans>
          </FieldLabel>
          <Select
            disabled={workflow === null || versions?.state !== "ready"}
            items={versionItems}
            onValueChange={(value: unknown) => {
              if (typeof value === "number") {
                setChosen(value);
              }
            }}
            value={chosen}
          >
            <SelectTrigger className="w-full" id={versionId}>
              <SelectValue placeholder={t`Choose a version`} />
            </SelectTrigger>
            <SelectContent>
              {versionItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {versions === undefined || versions.state === "ready" ? null : (
            <NotLoaded page={versions} />
          )}
        </Field>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy || !aliasValid || chosen === null}
            onClick={() => {
              void bind();
            }}
          >
            <Trans>Bind</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Removing a binding, once confirmed. */
const Unbind = ({
  binding,
  onUnbound,
}: {
  binding: AppWorkflowBinding;
  onUnbound: () => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const { alias } = binding;
  const unbind = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.workflowResources.unbindFromApp(binding.id);
      return true;
    });
    if (done === true) {
      onUnbound();
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={<Button size="sm" variant="outline" />}
        >
          <Trans>Unbind</Trans>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Unbind {alias}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                The app can no longer start a workflow by this name, until a
                builder binds it again. Runs already started go on.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void unbind();
              }}
              variant="destructive"
            >
              <Trans>Unbind</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** The bindings as read, with binding and unbinding for who may. */
const BindingsView = ({
  app,
  bindings,
  workflows,
  changes,
  onChanged,
}: {
  app: string;
  bindings: readonly AppWorkflowBinding[];
  workflows: readonly WorkflowResource[];
  /** Whether the person may bind and unbind: not on an archived App. */
  changes: boolean;
  onChanged: () => void;
}) => {
  const [binding, setBinding] = useState<Binding | null>(null);
  const names = new Map(workflows.map((each) => [each.id, each.name]));
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          <Trans>Workflows the app starts</Trans>
        </h2>
        {changes ? (
          <Button
            onClick={() => {
              setBinding({ alias: "", workflow: null, version: null });
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Bind a workflow</Trans>
          </Button>
        ) : null}
      </div>
      {bindings.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>The app starts no workflow of its own.</Trans>
        </p>
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">
                  <Trans>Name in the app&apos;s code</Trans>
                </TableHead>
                <TableHead variant="card">
                  <Trans>Workflow</Trans>
                </TableHead>
                <TableHead className="w-24" variant="card">
                  <Trans>Version</Trans>
                </TableHead>
                <TableHead className="w-44" variant="card">
                  <Trans>Bound</Trans>
                </TableHead>
                {changes ? (
                  <TableHead className="w-48" variant="card">
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
                  <TableCell variant="card">{each.version}</TableCell>
                  <TableCell variant="card">
                    {formatDateTime(each.boundAt)}
                  </TableCell>
                  {changes ? (
                    <TableCell variant="card">
                      <div className="flex justify-end gap-2">
                        <Button
                          onClick={() => {
                            setBinding({
                              alias: each.alias,
                              workflow: names.has(each.workflowId)
                                ? each.workflowId
                                : null,
                              version: null,
                            });
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          <Trans>Change version</Trans>
                        </Button>
                        <Unbind binding={each} onUnbound={onChanged} />
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
          onBound={onChanged}
          onClose={() => {
            setBinding(null);
          }}
          start={binding}
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
 * The workflows a domain's App binds, for its builders, read when the
 * Resources tab opens and again after each change.
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
  const [read, setRead] = useState<Loaded<Read>>();
  // Counts the changes made here, so each reads the bindings again.
  const [changed, setChanged] = useState(0);
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `changed` says when to read again
  }, [app.id, builds, changed, core]);
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
      changes={app.status !== "archived"}
      onChanged={() => {
        setChanged((count) => count + 1);
      }}
      workflows={read.data.workflows}
    />
  );
};
