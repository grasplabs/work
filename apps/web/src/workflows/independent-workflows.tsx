import type { BusinessProcess } from "@grasp-os/shared/business-processes";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import {
  ProcessGlyph,
  ProcessHint,
  processNames,
} from "./business-process.tsx";

// The organization's independent workflows the person has a role in
// (platform specification 13), each opening its own page, and, for those
// who build, a new one by name. Each line begins with the icon of the
// business process it serves, if its builders set one. Core decides who
// may create one and which names are free.

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

/** The process a workflow serves, as its icon, named when pointed at. */
const ProcessMark = ({ process }: { process: BusinessProcess }) => {
  const { i18n } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex-none" />}>
        <ProcessGlyph
          className="text-muted-foreground size-4"
          process={process}
        />
        <span className="sr-only">{i18n._(processNames[process])}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <ProcessHint process={process} />
      </TooltipContent>
    </Tooltip>
  );
};

export const IndependentWorkflows = ({
  workflows,
  canCreate,
  filtered = false,
}: {
  workflows: WorkflowResource[];
  canCreate: boolean;
  /** Whether a process filters them: none listed then says so. */
  filtered?: boolean;
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
          {filtered ? (
            <Trans>No independent workflow of yours serves this process.</Trans>
          ) : (
            <Trans>No independent workflow is shared with you yet.</Trans>
          )}
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
                  <span className="flex items-center gap-2">
                    {workflow.process === null ? null : (
                      <ProcessMark process={workflow.process} />
                    )}
                    <Link
                      className="font-medium hover:underline"
                      params={{ workflow: workflow.id }}
                      to="/workflows/$workflow"
                    >
                      {workflow.name}
                    </Link>
                  </span>
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
