import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { PersonPicker } from "../people/person-picker.tsx";
import type { Pickable } from "../people/person-picker.tsx";
import { useCore } from "../use-core.ts";

// A workflow's owner on its line, changed right there (GRA-450): people
// to pick from, read when the list first opens: the organization's
// members for an admin, whom the App is shared with for its builders.
// Core decides who may own it (a member who can open the App) and who may
// change it (`changesOwner`: an admin or a builder of the App); a refusal
// is said in a toast, and the line keeps the owner it had. An independent
// workflow's owner is who created it, and isn't changed here.

export const WorkflowOwnerPicker = ({
  workflow,
}: {
  workflow: WorkflowSummary;
}) => {
  const core = useCore();
  const router = useRouter();
  const { t } = useLingui();
  const [people, setPeople] = useState<Pickable[] | null>(null);
  const { owner } = workflow;
  const name = owner.name ?? owner.userId;
  const readPeople = async (): Promise<void> => {
    if (people !== null || workflow.type !== "app") {
      return;
    }
    const current = { id: owner.userId, name };
    let read: Pickable[] = [current];
    try {
      // An admin lists the whole organization.
      const members = await core.withSession(
        async (session) => await session.members.list()
      );
      read = members.map(({ userId, name: each, email }) => ({
        id: userId,
        name: each,
        email,
      }));
    } catch {
      // Anyone else may only list whom the App is shared with: people who
      // can open it, so may own its workflow. Its teams' people can too,
      // but aren't listed one by one.
      try {
        const shared = await core.withSession(
          async (session) => await session.apps.members.list(workflow.app)
        );
        read = [
          current,
          ...shared.flatMap((member) =>
            member.type === "person" &&
            member.name !== null &&
            member.id !== owner.userId
              ? [{ id: member.id, name: member.name }]
              : []
          ),
        ];
      } catch {
        // Only the owner is offered.
      }
    }
    setPeople(read.toSorted((a, b) => a.name.localeCompare(b.name)));
  };
  const pick = async (person: Pickable): Promise<void> => {
    if (workflow.type !== "app") {
      return;
    }
    try {
      await core.withSession(async (session) => {
        await changeThenRefresh(
          async () =>
            await session.workflows.setOwner(
              workflow.app,
              workflow.workflow,
              person.id
            ),
          async () => {
            await router.invalidate({ sync: true });
          }
        );
      });
    } catch (error) {
      const chosen = person.name;
      const named = workflow.workflow;
      toast.add({
        type: "error",
        title: t`Couldn't make ${chosen} the owner of ${named}`,
        description: failureText(error),
      });
    }
  };
  return (
    <PersonPicker
      compact
      disabled={workflow.type !== "app" || !workflow.changesOwner}
      onOpen={() => {
        void readPeople();
      }}
      onPick={(person) => {
        void pick(person);
      }}
      owner={name}
      ownerId={owner.userId}
      people={people}
    />
  );
};
