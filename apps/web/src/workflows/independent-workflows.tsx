import { failureText } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";

// A new independent workflow by name (platform specification 13), for those
// who build. The ones the person has a role in are listed with the App's
// in the workflows overview. Core decides who may create one and which
// names are free.

/** Creates a workflow named as typed, and opens it. */
export const NewWorkflow = () => {
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
