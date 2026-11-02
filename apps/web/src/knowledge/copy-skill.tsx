import { documentTypeOf, knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { DocumentRead, DocumentSummary } from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Copying a Grasp skill into the client's own skills ("Our skills") to
// adapt it there: an admin, reading a skill Grasp ships, copies its
// current version to the same path in Our skills, which core creates the
// first time an admin asks (`skillCollections`), then opens the copy to
// edit. Grasp's own stays as each release ships it; where both apply, the
// copy takes its place. Core decides who may copy, and refuses a path Our
// skills has already, which this says instead of overwriting.

/** A copy made, or the path Our skills has a document at already. */
type CopyOutcome = { copied: DocumentSummary } | { taken: string };

/**
 * Copies `doc` into the client's skills, creating that collection first
 * if it isn't there yet. Outside the component, as the React Compiler
 * can't compile `try`/`catch` around a value it returns.
 */
const copyInto = async (
  session: Session,
  doc: DocumentRead
): Promise<CopyOutcome> => {
  await session.knowledge.skillCollections();
  try {
    return {
      copied: await session.knowledge.copySkill({ documentId: doc.id }),
    };
  } catch (error) {
    if (knowledgeErrors.codeOf(error) !== "knowledge.conflict") {
      throw error;
    }
  }
  return { taken: doc.path };
};

/** Whether `doc` is a skill: only a skill is copied. */
export const isSkill = (doc: DocumentRead): boolean =>
  documentTypeOf(doc.type) === "skill";

/** Why nothing was copied: Our skills has a document at `path` already. */
const TakenText = ({ path }: { path: string }) => (
  <output className="text-muted-foreground text-sm">
    <Trans>Our skills has a skill at {path} already: adapt that one.</Trans>
  </output>
);

/** "Copy into Our skills", for an admin reading one of Grasp's skills. */
export const CopySkill = ({ doc }: { doc: DocumentRead }) => {
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [taken, setTaken] = useState<string>();

  const copy = async (): Promise<void> => {
    setTaken(undefined);
    const outcome = await run(async (session) => await copyInto(session, doc));
    if (outcome === undefined) {
      return;
    }
    if ("taken" in outcome) {
      setTaken(outcome.taken);
      return;
    }
    await navigate({
      to: "/knowledge/$collection",
      params: { collection: outcome.copied.collectionId },
      search: { doc: outcome.copied.id },
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={busy}
        onClick={() => {
          void copy();
        }}
        size="sm"
        variant="outline"
      >
        <CopyIcon data-icon="inline-start" />
        <Trans>Copy into Our skills</Trans>
      </Button>
      {taken === undefined ? null : <TakenText path={taken} />}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
