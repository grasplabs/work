import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Plus } from "../grasp/icons/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { AgentForm } from "./agent-form.tsx";
import type { Typed } from "./agent-form.tsx";

// A new agent, for the company's admins: its name, what it is for, its
// picture, its model and its instructions, said once. A task in a dialog
// from the Agents page (NewAgentButton); /agents/new has the same form
// on a page of its own, for a link. Core makes it on, reaching nobody
// and with nothing it may do (agent-builder.ts), so the page it then
// opens is the agent's Access tab: an agent nobody may ask is not yet
// any use.

/** A new agent before anything is said of it. */
const blank: Typed = {
  name: "",
  job: "",
  instructions: "",
  face: "stephen",
  model: null,
};

/** Every part a new agent is made with. */
const parts = ["name", "job", "face", "model", "instructions"] as const;

/** Makes the agent `said` describes, then opens its Access tab. */
const useMakeAgent = () => {
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const make = async (said: Partial<Typed>): Promise<void> => {
    // Every part is this form's, so all are said.
    const typed = { ...blank, ...said };
    await run(async (session) => {
      const made = await session.connections.makeAgent({
        ...typed,
        modelRole: null,
      });
      await navigate({
        to: "/agents/$agent",
        params: { agent: made.id },
        search: { tab: "access" },
      });
    });
  };
  return { busy, failure, make };
};

/** The one line under the new agent's title. */
const useLead = () => {
  const { t } = useLingui();
  return t`It starts reaching nobody. You choose who may ask it next.`;
};

/** New agent on the Agents page: its button, and the dialog it opens. */
export const NewAgentButton = ({ models }: { models: readonly string[] }) => {
  const { t } = useLingui();
  const formId = useId();
  const lead = useLead();
  const [open, setOpen] = useState(false);
  const { busy, failure, make } = useMakeAgent();
  return (
    <>
      <Button
        icon={Plus}
        onClick={() => {
          setOpen(true);
        }}
        variant="ink"
      >
        {t`New agent`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogPanel closeLabel={t`Close`}>
          <DialogTitle>{t`New agent`}</DialogTitle>
          <DialogDescription>{lead}</DialogDescription>
          <DialogBody>
            {/* Mounted only while open, so it starts blank each time. */}
            {open ? (
              <AgentForm
                can={!busy}
                id={formId}
                initial={blank}
                models={models}
                onSave={make}
                parts={parts}
              />
            ) : null}
            <AgentFailure>{failure}</AgentFailure>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button disabled={busy} form={formId} type="submit" variant="ink">
              {t`Make agent`}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </Dialog>
    </>
  );
};

/** /agents/new: the same form on a page of its own; `models`, the ones the organization chose. */
export const NewAgent = ({ models }: { models: readonly string[] }) => {
  const { t } = useLingui();
  const formId = useId();
  const lead = useLead();
  const { busy, failure, make } = useMakeAgent();
  return (
    <Page>
      <PageHeading
        action={
          <Button disabled={busy} form={formId} type="submit" variant="ink">
            {t`Make agent`}
          </Button>
        }
        description={lead}
        title={t`New agent`}
      />
      <Card>
        <AgentForm
          can={!busy}
          id={formId}
          initial={blank}
          models={models}
          onSave={make}
          parts={parts}
        />
      </Card>
      <AgentFailure>{failure}</AgentFailure>
    </Page>
  );
};
