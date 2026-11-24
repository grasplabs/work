import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowLabel } from "@grasp-os/shared/workflow-resources";
import type {
  AppWorkflowBinding,
  WorkflowResource,
} from "@grasp-os/shared/workflow-resources";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import {
  Select,
  SelectContent,
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
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import { useDraft } from "../drafts/use-draft.ts";
import { formatDateTime } from "../format.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
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

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: space[3] },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space[2],
  },
});

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
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [problem, setProblem] = useState<string>();
  const [workflow, setWorkflow] = useState<string | null>(
    workflows.some((each) => each.id === binding.workflowId)
      ? binding.workflowId
      : null
  );
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
      // The dialog stays open, with core's reason in it.
      throw new Error("Not changed");
    }
    if (!changed.ok) {
      setProblem(changed.problem);
      throw new Error("Not changed");
    }
    onDrafted();
    onClose();
  };
  const workflowItems = workflows.map((each) => ({
    value: each.id,
    label: workflowLabel(each),
  }));
  const shown = failure ?? problem;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Change what ${alias} starts`}</DialogTitle>
          <DialogDescription>
            {t`The change goes into the App's draft, which declares what the workflow's live version has. Once you publish the draft, the App starts that workflow's live version by this name. Starting it still takes the App's own permission on the workflow, which an admin grants.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <Field>
              <FieldLabel>{t`Workflow`}</FieldLabel>
              <Select
                items={workflowItems}
                onValueChange={(value) => {
                  if (value !== null) {
                    setWorkflow(value);
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
            {shown === undefined ? null : (
              <Alert variant="destructive">
                <AlertDescription>{shown}</AlertDescription>
              </Alert>
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            size="sm"
            disabled={busy || workflow === null || revision === undefined}
            errorText={t`Could not change`}
            loadingText={t`Changing`}
            onClick={bind}
            variant="default"
          >
            {t`Change in the draft`}
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
  const { t } = useLingui();
  const [binding, setBinding] = useState<AppWorkflowBinding | null>(null);
  const [drafted, setDrafted] = useState(false);
  const names = new Map(
    workflows.map((each) => [each.id, workflowLabel(each)])
  );
  return (
    <Card size="sm" asChild>
      <section aria-label={t`Workflows the App starts`}>
        <CardHeader>
          <CardTitle level={3}>{t`Workflows the App starts`}</CardTitle>
        </CardHeader>
        <CardContent flush={bindings.length > 0 && !drafted}>
          <div {...stylex.props(styles.section)}>
            {drafted ? (
              <Text size="sm" color="muted">
                {t`Changed in the draft: publish the App for it to start the new workflow.`}
              </Text>
            ) : null}
            {bindings.length === 0 ? (
              <Text size="sm" color="muted">
                {t`The App starts no workflow of its own.`}
              </Text>
            ) : (
              <Table aria-label={t`Workflows the App starts`} density="compact">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t`Name in the App's code`}</TableHead>
                    <TableHead>{t`Workflow`}</TableHead>
                    <TableHead>{t`Bound`}</TableHead>
                    {changes ? <TableHead aria-label={t`Actions`} /> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bindings.map((each) => (
                    <TableRow key={each.id}>
                      <TableCell rowHeader>{each.alias}</TableCell>
                      <TableCell>
                        {names.get(each.workflowId) ?? each.workflowId}
                      </TableCell>
                      <TableCell>{formatDateTime(each.boundAt)}</TableCell>
                      {changes ? (
                        <TableCell align="end">
                          <div {...stylex.props(styles.actions)}>
                            <Button
                              onClick={() => {
                                setBinding(each);
                              }}
                              size="sm"
                              variant="ghost"
                            >
                              {t`Change`}
                            </Button>
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          {binding === null ? null : (
            <BindDialog
              app={app}
              binding={binding}
              onClose={() => {
                setBinding(null);
              }}
              onDrafted={() => {
                setDrafted(true);
              }}
              revision={revision}
              workflows={bindable(workflows)}
            />
          )}
        </CardContent>
      </section>
    </Card>
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
  // Counts the tries, so Try again reads them again.
  const [tried, setTried] = useState(0);
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `tried` says when to read again
  }, [app.id, builds, core, tried]);
  if (!builds) {
    return null;
  }
  if (read === undefined) {
    return <LoadingLines lines={2} />;
  }
  if (read.state !== "ready") {
    return (
      <NotLoadedState
        again={() => {
          setTried(tried + 1);
        }}
        heading="h3"
        page={read}
      />
    );
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
