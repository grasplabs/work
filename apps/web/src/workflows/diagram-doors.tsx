import type { DiagramDoor, DoorFlow } from "@grasp-os/shared/workflow-diagrams";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CornerDownLeftIcon,
  DoorOpenIcon,
  GitBranchIcon,
} from "lucide-react";

import type { DoorPlace } from "./diagram-parts.ts";

// A workflow's doors (prototype `inside-doors.tsx`): the other workflows
// its tasks lead to, listed beside the drawing's own controls. Pressing
// one shows the tasks that lead there in the drawing, and the other
// workflow beside it, with the way to its own page. A workflow the reader
// can't see is a door like any other, nameless and closed.

const flowIcons = {
  waits: CornerDownLeftIcon,
  starts: GitBranchIcon,
  hands: ArrowUpRightIcon,
} as const;

/** How the work goes through a door, in words. */
const useFlowText = (flow: DoorFlow): string => {
  const { t } = useLingui();
  return {
    waits: t`Waits for it`,
    starts: t`Also starts it`,
    hands: t`Handed over to it`,
  }[flow];
};

/** The name of the workflow behind a door, or that the reader can't see it. */
const useDoorName = (door: Pick<DiagramDoor, "name">): string => {
  const { t } = useLingui();
  return door.name ?? t`A workflow you can't see`;
};

/** A door on the task that leads through it. */
export const DoorBadge = ({ door }: { door: DiagramDoor }) => {
  const name = useDoorName(door);
  const flow = useFlowText(door.flow);
  const Icon = flowIcons[door.flow];
  return (
    <Badge variant="outline">
      <Icon aria-hidden="true" />
      {flow}: {name}
    </Badge>
  );
};

const DoorItem = ({
  door,
  onGo,
}: {
  door: DoorPlace;
  onGo: (door: DoorPlace) => void;
}) => {
  const { t } = useLingui();
  const name = useDoorName(door);
  const flow = useFlowText(door.flow);
  const Icon = flowIcons[door.flow];
  const places = door.tasks.length;
  return (
    <DropdownMenuItem
      onClick={() => {
        onGo(door);
      }}
    >
      <Icon aria-hidden="true" />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium text-pretty">{name}</span>
        <span className="text-muted-foreground text-xs">{flow}</span>
        {places > 1 ? (
          <span className="text-muted-foreground text-xs">
            {t`${plural(places, { one: "In # place", other: "In # places" })}`}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
};

/** The doors, beside the drawing's controls: pick one to go to it. */
export const DoorsMenu = ({
  doors,
  onGo,
}: {
  doors: readonly DoorPlace[];
  onGo: (door: DoorPlace) => void;
}) => {
  const count = doors.length;
  if (count === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>
        <DoorOpenIcon aria-hidden="true" data-icon="inline-start" />
        <Trans context="the other workflows a workflow goes on in">Doors</Trans>
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {doors.map((door) => (
          <DoorItem
            door={door}
            key={`${door.workflowId ?? door.tasks.join(" ")} ${door.flow}`}
            onGo={onGo}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The workflow behind a door, beside the drawing. */
export const DoorSheet = ({
  door,
  onClose,
}: {
  door: DoorPlace | null;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const name = useDoorName(door ?? { name: null });
  const flow = useFlowText(door?.flow ?? "waits");
  const places = door?.tasks.length ?? 0;
  const target = door?.workflowId ?? null;
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={door !== null}
    >
      <SheetContent>
        <div className="flex flex-col gap-1 border-b px-6 py-5 pr-14">
          <SheetTitle>{name}</SheetTitle>
          <SheetDescription>{flow}</SheetDescription>
        </div>
        <div className="flex flex-col gap-4 px-6 py-5">
          <p className="text-muted-foreground">
            {t`${plural(places, {
              one: "One task of this workflow leads there; it is marked in the drawing.",
              other:
                "# tasks of this workflow lead there; they are marked in the drawing.",
            })}`}
          </p>
          {target === null ? (
            <p className="text-muted-foreground">
              <Trans>
                You have no role in the workflow behind this door, so Grasp
                doesn&apos;t name it.
              </Trans>
            </p>
          ) : (
            <Button
              className="self-start"
              nativeButton={false}
              render={
                <Link params={{ workflow: target }} to="/workflows/$workflow" />
              }
              variant="outline"
            >
              <Trans>Open {name}</Trans>
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
