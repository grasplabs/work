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

// A workflow's owner on its line, changed right there (GRA-450): the
// organization's members to pick from, read when the list first opens.
// Core decides who may own it (a member who can open the App) and who may
// change it (`changesOwner`: an admin or a builder of the App); a refusal
// is said in a toast, and the line keeps the owner it had.

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
    if (people !== null) {
      return;
    }
    try {
      const members = await core.withSession(
        async (session) => await session.members.list()
      );
      setPeople(
        members
          .map(({ userId, name: each, email }) => ({
            id: userId,
            name: each,
            email,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name))
      );
    } catch {
      // The members couldn't be read (Grasp staff list none): only the owner is offered.
      setPeople([{ id: owner.userId, name }]);
    }
  };
  const pick = async (person: Pickable): Promise<void> => {
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
      disabled={!workflow.changesOwner}
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
