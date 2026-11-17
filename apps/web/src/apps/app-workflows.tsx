import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { appWorkflowBindingSchema } from "@grasp-os/shared/workflow-resources";
import type {
  AppWorkflowBinding,
  WorkflowResource,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import { formatDateTime } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Workflow } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// The workflows an App's App starts, on the App's Resources tab, for
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

const styles = stylex.create({
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: grasp.space2,
  },
});

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
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [alias, setAlias] = useState(start.alias);
  const [workflow, setWorkflow] = useState(start.workflow);
  const [chosen, setChosen] = useState(start.version);
  const [versions, setVersions] = useState<Loaded<WorkflowResourceVersion[]>>();
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
    if (bound === undefined) {
      // The dialog stays open, with core's reason in it.
      throw new Error("Not bound");
    }
    onBound();
    onClose();
  };
  const workflowItems = workflows.map((each) => ({
    value: each.id,
    label: each.name,
  }));
  const versionItems = published.map((version) => ({
    value: String(version),
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
        <DialogTitle>
          {naming ? t`Bind a workflow` : t`Change what ${alias} starts`}
        </DialogTitle>
        <DialogDescription>
          {t`The App starts this exact version by its name, until a builder binds another. Starting it still takes the App's own permission on the workflow, which an admin grants.`}
        </DialogDescription>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            {naming ? (
              <Field invalid={alias !== "" && !aliasValid}>
                <FieldLabel>{t`Name in the App's code`}</FieldLabel>
                <Input maxLength={64} onValueChange={setAlias} value={alias} />
                {alias === "" || aliasValid ? (
                  <FieldDescription>
                    {t`A letter, then letters, digits or underscores, such as summary.`}
                  </FieldDescription>
                ) : (
                  <FieldError match>
                    {t`Start with a letter, then use only letters, digits or underscores.`}
                  </FieldError>
                )}
              </Field>
            ) : null}
            <Field>
              <FieldLabel>{t`Workflow`}</FieldLabel>
              <Select
                items={workflowItems}
                onValueChange={(value) => {
                  if (value !== null) {
                    setWorkflow(value);
                    setChosen(null);
                    setVersions(undefined);
                  }
                }}
                value={workflow}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t`Choose a workflow`} />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </Field>
            <Field>
              <FieldLabel>{t`Version`}</FieldLabel>
              <Select
                disabled={workflow === null || versions?.state !== "ready"}
                items={versionItems}
                onValueChange={(value) => {
                  if (value !== null) {
                    setChosen(Number(value));
                  }
                }}
                value={chosen === null ? null : String(chosen)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t`Choose a version`} />
                </SelectTrigger>
                <SelectContent />
              </Select>
              {versions === undefined || versions.state === "ready" ? null : (
                <NotLoaded page={versions} />
              )}
            </Field>
            {failure === undefined ? null : (
              <Alert tone="danger">{failure}</Alert>
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={bind}
            disabled={busy || !aliasValid || chosen === null}
            failedLabel={t`Could not bind`}
            variant="ink"
            workingLabel={t`Binding`}
          >
            {t`Bind`}
          </DialogAction>
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
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const { alias } = binding;
  const unbind = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.workflowResources.unbindFromApp(binding.id);
      return true;
    });
    if (done !== true) {
      // It stays open, with core's reason in it.
      throw new Error("Not unbound");
    }
    onUnbound();
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-label={t`Unbind ${alias}`}
        disabled={busy}
        size="sm"
        variant="ghost"
      >
        {t`Unbind`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Unbind ${alias}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`The App can no longer start a workflow by this name, until a builder binds it again. Runs already started go on.`}
        </AlertDialogDescription>
        {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            action={unbind}
            failedLabel={t`Could not unbind`}
            variant="danger"
            workingLabel={t`Unbinding`}
          >
            {t`Unbind`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const { t } = useLingui();
  const [binding, setBinding] = useState<Binding | null>(null);
  const names = new Map(workflows.map((each) => [each.id, each.name]));
  return (
    <SectionCard
      actions={
        changes ? (
          <Button
            icon={Workflow}
            onClick={() => {
              setBinding({ alias: "", workflow: null, version: null });
            }}
            size="sm"
          >
            {t`Bind a workflow`}
          </Button>
        ) : undefined
      }
      density="compact"
      flush={bindings.length > 0}
      headingLevel={3}
      title={t`Workflows the App starts`}
    >
      {bindings.length === 0 ? (
        <Text size="sm" tone="muted">
          {t`The App starts no workflow of its own.`}
        </Text>
      ) : (
        <Table aria-label={t`Workflows the App starts`} density="compact">
          <TableHeader>
            <TableRow>
              <TableHead>{t`Name in the App's code`}</TableHead>
              <TableHead>{t`Workflow`}</TableHead>
              <TableHead>{t`Version`}</TableHead>
              <TableHead>{t`Bound`}</TableHead>
              {changes ? <TableHead aria-label={t`Actions`} /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {bindings.map((each) => (
              <TableRow key={each.id}>
                <TableCell lead>{each.alias}</TableCell>
                <TableCell>
                  {names.get(each.workflowId) ?? each.workflowId}
                </TableCell>
                <TableCell>{each.version}</TableCell>
                <TableCell>{formatDateTime(each.boundAt)}</TableCell>
                {changes ? (
                  <TableCell align="end">
                    <div {...stylex.props(styles.actions)}>
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
                        {t`Change version`}
                      </Button>
                      <Unbind binding={each} onUnbound={onChanged} />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
    </SectionCard>
  );
};

/** What the section reads: the App's bindings, and the workflows to name them by. */
interface Read {
  bindings: AppWorkflowBinding[];
  workflows: WorkflowResource[];
}

/**
 * The workflows an App's App binds, for its builders, read when the
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
      changes={!app.archived}
      onChanged={() => {
        setChanged((count) => count + 1);
      }}
      workflows={read.data.workflows}
    />
  );
};
