import type { WorkflowGoLiveWaiting } from "@grasp-os/shared/workflow-lifecycle";
import { useLingui } from "@lingui/react/macro";

import { formatDateTime } from "../format.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
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
  if (waiting.length === 0) {
    return null;
  }
  return (
    <SectionCard
      density="compact"
      flush
      title={t`Waiting for you to let them go live`}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t`Workflow`}</TableHead>
            <TableHead>{t`Version`}</TableHead>
            <TableHead>{t`Asked by`}</TableHead>
            <TableHead>{t`Asked on`}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {waiting.map((each) => (
            <TableRow key={`${each.workflowId}/${each.version}`}>
              <TableCell lead>
                <RouterLink
                  params={{ workflow: each.workflowId }}
                  to="/workflows/$workflow"
                >
                  {each.name}
                </RouterLink>
              </TableCell>
              <TableCell>{each.version}</TableCell>
              <TableCell>
                {each.requestedBy === names.me
                  ? t`You`
                  : (names.people.get(each.requestedBy) ?? t`Someone else`)}
              </TableCell>
              <TableCell>{formatDateTime(each.requestedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
};
