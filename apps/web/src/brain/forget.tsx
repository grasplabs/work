import type {
  BrainForgetPreview,
  BrainForgetTarget,
} from "@grasp-os/shared/brain";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Progress } from "@grasp-os/ui/components/progress";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { useCore } from "../use-core.ts";
import { useBrainData } from "./brain-data.ts";
import { forgetEffect } from "./forget-effect.ts";

// Taking something out of the brain, the same way wherever it is offered
// (the prototype's `components/brain-forget.tsx`): it asks first and says
// what goes with it, from core's preview, since it can't be brought back.
// After the yes a card at the foot of the page counts five seconds down
// with a way to take it back; only then does core take it out. Leaving the
// page within those seconds does it at once: the yes was given.

/** How long a removal can be taken back before it is real, in seconds. */
const graceSeconds = 5;

/** How many notes the question names before it counts the rest. */
const notesNamed = 4;

/** Whether the person may take things out of the brain: the company's admins, as core decides it. */
export const useCanForget = (): boolean => {
  const { identity } = useRouteContext({ from: "/_shell" });
  return isAdmin(identity.role);
};

/** What is asked about: the target, what to call it, and what core said goes with it. */
interface Asking {
  target: BrainForgetTarget;
  what: string;
  preview?: BrainForgetPreview;
  failure?: string;
}

/** A removal on its way: the target and the seconds left to take it back. */
interface Going {
  target: BrainForgetTarget;
  left: number;
  failure?: string;
}

/** What the question says goes with it, once core said. */
const EffectLines = ({
  asking,
  preview,
}: {
  asking: Asking;
  preview: BrainForgetPreview;
}) => {
  const { t } = useLingui();
  const { workspace, brain } = useBrainData();
  const effect = forgetEffect(workspace, brain, asking.target, preview);
  const named = formatList(effect.notes.slice(0, notesNamed));
  const more = effect.notes.length - notesNamed;
  return (
    <>
      {"source" in asking.target && effect.statements > 0 ? (
        <p>
          {t`${plural(effect.statements, { one: "# thing that was said in it goes with it.", other: "# things that were said in it go with it." })}`}
        </p>
      ) : null}
      {effect.notes.length > 0 ? (
        <p>
          {more > 0
            ? t`These notes rest on nothing else and go too: ${named} and ${more} more.`
            : t`These notes rest on nothing else and go too: ${named}.`}
        </p>
      ) : null}
      {effect.workflows.length > 0 ? (
        <p>
          {t`${plural(effect.workflows.length, { one: "# workflow keeps its numbers, which will say their source was removed.", other: "# workflows keep their numbers, which will say their source was removed." })}`}
        </p>
      ) : null}
    </>
  );
};

/** The card at the foot of the page while a removal can still be taken back. */
const UndoCard = ({
  going,
  onUndo,
  onClose,
}: {
  going: Going;
  onUndo: () => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <output className="bg-card fixed inset-x-4 bottom-6 z-50 mx-auto flex max-w-sm flex-col gap-2 rounded-xl border p-3 text-sm shadow-lg">
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate">
          {going.failure ?? <Trans>Removed from the brain</Trans>}
        </span>
        {going.failure === undefined ? (
          <Button onClick={onUndo} size="sm" variant="ghost">
            <Trans context="take a removal back before it happens">Undo</Trans>
          </Button>
        ) : (
          <Button onClick={onClose} size="sm" variant="ghost">
            <Trans>Close</Trans>
          </Button>
        )}
      </span>
      {going.failure === undefined ? (
        <Progress
          aria-label={t`Time left to undo`}
          value={(going.left / graceSeconds) * 100}
        />
      ) : null}
    </output>
  );
};

/**
 * One way to take things out of the brain, for a page: `ask` opens the
 * question for a target, named `what`; `element` is the question and the
 * undo card, to render once on the page. `onGone` runs once core took it
 * out.
 */
export const useForget = (
  onGone?: (target: BrainForgetTarget) => void
): {
  ask: (target: BrainForgetTarget, what: string) => void;
  element: ReactNode;
} => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [going, setGoing] = useState<Going | null>(null);
  // What was said yes to and not yet taken out: taken out at once when the page goes.
  const pending = useRef<BrainForgetTarget | null>(null);
  const gone = useRef(onGone);
  useEffect(() => {
    gone.current = onGone;
  }, [onGone]);

  useEffect(() => {
    /** Takes `target` out of the brain for good, then reads the brain again. */
    const commit = async (target: BrainForgetTarget): Promise<void> => {
      pending.current = null;
      try {
        await core.withSession(
          async (session) => await session.brain.forget(target)
        );
      } catch (error) {
        setGoing({ target, left: 0, failure: failureText(error) });
        return;
      }
      setGoing(null);
      await router.invalidate();
      gone.current?.(target);
    };
    // A second at a time; after the last one it is taken out.
    const timer =
      going === null || going.failure !== undefined
        ? undefined
        : setTimeout(() => {
            if (going.left > 1) {
              setGoing({ ...going, left: going.left - 1 });
              return;
            }
            void commit(going.target);
          }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [going, core, router]);

  // The page goes while a removal is on its way: it happens now.
  useEffect(
    () => () => {
      const target = pending.current;
      if (target !== null) {
        void core.withSession(
          async (session) => await session.brain.forget(target)
        );
      }
    },
    [core]
  );

  /** Reads what goes with `target` from core, into the question while it still asks about it. */
  const preview = async (target: BrainForgetTarget): Promise<void> => {
    let said: Pick<Asking, "preview" | "failure">;
    try {
      said = {
        preview: await core.withSession(
          async (session) => await session.brain.forgetPreview(target)
        ),
      };
    } catch (error) {
      said = { failure: failureText(error) };
    }
    setAsking((now) => (now?.target === target ? { ...now, ...said } : now));
  };

  const ask = (target: BrainForgetTarget, what: string): void => {
    setAsking({ target, what });
    void preview(target);
  };

  const what = asking?.what ?? "";
  const element = (
    <>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setAsking(null);
          }
        }}
        open={asking !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Remove ${what} from the brain?`}</AlertDialogTitle>
            <AlertDialogDescription
              render={<div className="flex flex-col gap-2" />}
            >
              <p>
                <Trans>
                  It is gone for good and cannot be brought back. The audit
                  trail keeps that it was removed and by whom, never what it
                  was.
                </Trans>
              </p>
              {asking?.preview === undefined ? null : (
                <EffectLines asking={asking} preview={asking.preview} />
              )}
              {asking?.failure === undefined ? null : (
                <p className="text-destructive">{asking.failure}</p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep it</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={asking?.preview === undefined}
              onClick={() => {
                if (asking?.preview === undefined) {
                  return;
                }
                pending.current = asking.target;
                setGoing({ target: asking.target, left: graceSeconds });
                setAsking(null);
              }}
              variant="destructive"
            >
              {asking !== null &&
              asking.preview === undefined &&
              asking.failure === undefined ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              <Trans>Remove it</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {going === null ? null : (
        <UndoCard
          going={going}
          onClose={() => {
            setGoing(null);
          }}
          onUndo={() => {
            pending.current = null;
            setGoing(null);
          }}
        />
      )}
    </>
  );
  return { ask, element };
};

/** The button that asks to take something out of the brain. */
export const ForgetButton = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-label={label}
      onClick={onClick}
      size="icon-sm"
      title={t`Remove from the brain`}
      variant="ghost"
    >
      <Trash2Icon />
    </Button>
  );
};
