import type { Blueprint } from "@grasp-os/shared/apps";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { CheckIcon, LayoutTemplateIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// Blueprints, as in the prototype (grasplabs/prototype
// `components/apps/new-app-dialog.tsx`, `blueprint-dialog.tsx`): a version
// of an App saved to start new Apps from, and picking one to start a new
// App as a copy of it. Core names a blueprint after its App as it was
// saved, so saving asks for no name. The prototype's picture of each
// blueprint's screen isn't here: core has no picture of a version's screen.

/** One blueprint: its name, what it is for, who saved it, and the way to remove it. */
const BlueprintCard = ({
  blueprint,
  people,
  busy,
  onPick,
  onRemove,
}: {
  blueprint: Blueprint;
  people: ReadonlyMap<string, string>;
  busy: boolean;
  onPick: () => void;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  const { name, markedBy } = blueprint;
  const date = formatDate(blueprint.markedAt);
  const person = markedBy === null ? null : (people.get(markedBy) ?? markedBy);
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-xl border p-3">
      <button
        aria-label={t`Start from ${name}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none focus-visible:underline disabled:opacity-50"
        disabled={busy}
        onClick={onPick}
        type="button"
      >
        <span className="truncate font-medium">{name}</span>
        {blueprint.description === "" ? null : (
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {blueprint.description}
          </span>
        )}
        <span className="text-muted-foreground text-xs">
          {person === null ? (
            <Trans>Comes with Grasp</Trans>
          ) : (
            <Trans>
              Saved by {person} on {date}
            </Trans>
          )}
        </span>
      </button>
      {/* A built-in comes with the release: nobody removes it. */}
      {blueprint.app === null ? null : (
        <Button
          aria-label={t`Remove the blueprint ${name}`}
          disabled={busy}
          onClick={onRemove}
          size="icon-xs"
          title={t`Remove the blueprint ${name}`}
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      )}
    </li>
  );
};

/**
 * Start from a blueprint: the blueprints the person may start from, and
 * picking one makes a new App of theirs as a copy of it, named as it is,
 * and opens it.
 */
export const StartFromBlueprint = ({
  blueprints,
  people,
}: {
  blueprints: readonly Blueprint[];
  /** People's names by ID, for who saved each. */
  people: ReadonlyMap<string, string>;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const start = async (blueprint: Blueprint): Promise<void> => {
    const created = await run(
      async (session) =>
        await session.apps.blueprints.create(blueprint.id, {
          name: blueprint.name,
          description: blueprint.description,
        })
    );
    if (created !== undefined) {
      setOpen(false);
      await navigate({
        to: "/domains/$engine",
        params: { engine: created.app.id },
      });
    }
  };
  const remove = async (blueprint: Blueprint): Promise<void> => {
    await run(async (session) => {
      await session.apps.blueprints.unmark(blueprint.id);
    });
    await router.invalidate();
  };
  return (
    <>
      <Button
        className="self-center"
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
      >
        <LayoutTemplateIcon data-icon="inline-start" />
        <Trans>Start from a blueprint</Trans>
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-2xl" closeLabel={t`Close`}>
          <DialogHeader>
            <DialogTitle>
              <Trans>Start from a blueprint</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                The new app starts as a copy of it, with none of its data. Its
                access waits for an admin.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          {blueprints.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  <Trans>No blueprints yet</Trans>
                </EmptyTitle>
                <EmptyDescription>
                  <Trans>
                    Save an app as a blueprint from its domain, and it shows
                    here.
                  </Trans>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul
              aria-label={t`Blueprints`}
              className="grid max-h-96 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2"
            >
              {blueprints.map((blueprint) => (
                <BlueprintCard
                  blueprint={blueprint}
                  busy={busy}
                  key={blueprint.id}
                  onPick={() => {
                    void start(blueprint);
                  }}
                  onRemove={() => {
                    void remove(blueprint);
                  }}
                  people={people}
                />
              ))}
            </ul>
          )}
          <ErrorText>{failure}</ErrorText>
        </DialogContent>
      </Dialog>
    </>
  );
};

/**
 * Save as blueprint: marks the App's current version as a blueprint,
 * under the App's own name and description. The App stays as it is.
 */
export const SaveAsBlueprint = ({
  app,
  name,
  version,
}: {
  app: string;
  name: string;
  version: number;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = async (): Promise<void> => {
    const marked = await run(
      async (session) => await session.apps.blueprints.mark(app, version)
    );
    if (marked !== undefined) {
      setSaved(true);
    }
  };
  return (
    <>
      <Button
        onClick={() => {
          setSaved(false);
          setOpen(true);
        }}
        variant="outline"
      >
        <LayoutTemplateIcon data-icon="inline-start" />
        <Trans>Save as blueprint</Trans>
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-md" closeLabel={t`Close`}>
          <DialogHeader>
            <DialogTitle>
              {saved ? (
                <Trans>Saved as a blueprint</Trans>
              ) : (
                <Trans>Save {name} as a blueprint</Trans>
              )}
            </DialogTitle>
            <DialogDescription>
              {saved ? (
                <Trans>
                  Anyone who builds and has a role in {name} can now start a new
                  app from it. {name} itself stays as it is.
                </Trans>
              ) : (
                <Trans>
                  New apps can start from version {version} of {name}, as a copy
                  with none of its data. {name} itself stays as it is.
                </Trans>
              )}
            </DialogDescription>
          </DialogHeader>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            {saved ? (
              <>
                <CheckIcon
                  aria-hidden="true"
                  className="text-status-agreed size-4 self-center"
                />
                <Button
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  <Trans>Done</Trans>
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={() => {
                    setOpen(false);
                  }}
                  variant="ghost"
                >
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void save();
                  }}
                >
                  <Trans>Save as blueprint</Trans>
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
