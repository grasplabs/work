import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";

// The organization's independent workflows the person has a role in
// (platform specification 13), each opening its own page, and, for those
// who build, a new one by name. Core decides who may create one and which
// names are free.

/** Creates a workflow named as typed, and opens it. */
const NewWorkflow = () => {
  const core = useCore();
  const navigate = useNavigate();
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const create = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try {
      const created = await core.withSession(
        async (session) => await session.workflowResources.create(name)
      );
      await navigate({
        to: "/workflows/$workflow",
        params: { workflow: created.id },
      });
    } catch (error) {
      setFailure(failureText(error));
    }
    setBusy(false);
  };
  return (
    <form
      aria-label={t`New workflow`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <Label htmlFor="new-workflow-name">
        <Trans>Name of a new workflow</Trans>
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          id="new-workflow-name"
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder="invoice-approval"
          value={name}
        />
        <Button disabled={busy || name === ""} type="submit">
          <Trans>Create</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

export const IndependentWorkflows = ({
  workflows,
  canCreate,
}: {
  workflows: WorkflowResource[];
  canCreate: boolean;
}) => {
  const { t } = useLingui();
  return (
    <section
      aria-labelledby="independent-workflows"
      className="flex flex-col gap-3"
    >
      <h2 className="font-medium" id="independent-workflows">
        <Trans>Independent workflows</Trans>
      </h2>
      {workflows.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No independent workflow is shared with you yet.</Trans>
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t`Name`}</TableHead>
              <TableHead>{t`Current version`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workflows.map((workflow) => (
              <TableRow key={workflow.id}>
                <TableCell>
                  <Link
                    className="font-medium hover:underline"
                    params={{ workflow: workflow.id }}
                    to="/workflows/$workflow"
                  >
                    {workflow.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {workflow.currentVersion ?? t`Not published`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canCreate ? <NewWorkflow /> : null}
    </section>
  );
};
