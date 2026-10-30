import type { WorkflowGoLiveWaiting } from "@grasp-os/shared/workflow-lifecycle";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { formatDateTime } from "../format.ts";
import type { Names } from "./activity-bar.tsx";

// The independent workflows whose version waits for the reader to let it
// go live (`workflowResources.lifecycle.waiting`, as the inbox reads
// them): as their owner, as an admin, or as whoever asked when nobody else
// may decide. The prototype's "Needs you" counts them with the workflows
// whose runs wait; each opens its page, where it is approved or sent back.

export const GoLivesWaiting = ({
  waiting,
  names,
}: {
  waiting: WorkflowGoLiveWaiting[];
  names: Names;
}) => {
  const { t } = useLingui();
  const titleId = useId();
  if (waiting.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <h2 className="text-muted-foreground" id={titleId}>
        <Trans>Waiting for you to let them go live</Trans>
      </h2>
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">{t`Workflow`}</TableHead>
              <TableHead variant="card">{t`Version`}</TableHead>
              <TableHead variant="card">{t`Asked by`}</TableHead>
              <TableHead variant="card">{t`Asked on`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {waiting.map((each) => (
              <TableRow key={`${each.workflowId}/${each.version}`}>
                <TableCell variant="roomy">
                  <Link
                    className="font-medium hover:underline"
                    params={{ workflow: each.workflowId }}
                    to="/workflows/$workflow"
                  >
                    {each.name}
                  </Link>
                </TableCell>
                <TableCell variant="roomy">{each.version}</TableCell>
                <TableCell variant="roomy">
                  {each.requestedBy === names.me
                    ? t`You`
                    : (names.people.get(each.requestedBy) ?? t`Someone else`)}
                </TableCell>
                <TableCell variant="roomy">
                  {formatDateTime(each.requestedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
};
