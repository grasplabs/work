import { useNavigate } from "@tanstack/react-router";

import { setActiveChat } from "../chat/active-chat.ts";
import { setDockMode } from "../chat/dock-mode.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useMadeOnce } from "../use-made-once.ts";

// Making a workflow, from New workflow on the Workflows page or New in a
// project: it opens on its empty Flow, with a new chat docked open beside
// it asking how the work runs (draw-in-chat.ts). Core decides who may
// create one and which names are free.

/** Runs of what a workflow's name may not hold, and dashes at its ends. */
const notInName = /[^a-z0-9]+/gu;
/** The accents NFKD splits off letters: "ü" keeps its "u". */
const accents = /\p{M}/gu;
const edgeDashes = /^-+|-+$/gu;

/**
 * A workflow's name from what was typed: core's names are lowercase
 * letters, digits and dashes (`workflowNameSchema`), and a workflow's
 * name is its own for good, so it takes a part nobody had. "Invoice
 * approvals" becomes `invoice-approvals-1a2b3c4d`; nothing typed,
 * `new-workflow-1a2b3c4d`.
 */
export const workflowNameOf = (typed: string): string => {
  const words = typed
    .normalize("NFKD")
    .replaceAll(accents, "")
    .toLowerCase()
    .replaceAll(notInName, "-")
    .replaceAll(edgeDashes, "")
    .slice(0, 48)
    .replaceAll(edgeDashes, "");
  return `${words === "" ? "new-workflow" : words}-${crypto.randomUUID().slice(0, 8)}`;
};

/**
 * Makes a workflow named after what was typed, `then` does what else goes
 * with it (filing it in a project), and opens it with a new chat docked
 * beside it. When `then` fails, the workflow made stays the one made: a
 * second try with the same name does only what failed, never making
 * another.
 */
export const useNewWorkflow = () => {
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { once, forget } = useMadeOnce();
  const make = async (
    typed: string,
    then?: (session: Session, id: string) => Promise<void>
  ): Promise<void> => {
    const id = await run(async (session) => {
      const workflow = await once(typed, async () => {
        const created = await session.workflowResources.create(
          workflowNameOf(typed)
        );
        return created.id;
      });
      await then?.(session, workflow);
      return workflow;
    });
    if (id === undefined) {
      return;
    }
    forget();
    // A new chat, the person's like any other, docked open down the right
    // beside the Flow it draws: the next question there starts it.
    setActiveChat(undefined);
    setDockMode("drawer");
    await navigate({ to: "/workflows/$workflow", params: { workflow: id } });
  };
  return { busy, failure, make };
};
