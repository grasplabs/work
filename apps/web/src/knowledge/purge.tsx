import {
  purgeMaxDocuments,
  purgeMaxTerms,
  purgeReasonSchema,
} from "@grasp-os/shared/knowledge";
import type {
  DocumentSummary,
  PurgeInput,
  PurgePlan,
  PurgeReason,
  PurgeResult,
} from "@grasp-os/shared/knowledge";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Textarea } from "@grasp-os/ui/components/textarea";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { EllipsisIcon, UserXIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// Purging personal data from a collection, for an admin: the terms to take
// out (a name, its other forms, an email address), from every version of
// the collection's documents, and why. Core first says what the purge would
// remove, and nothing changes until the admin confirms exactly that plan
// (`preparePurge`, then `purge` with its token, before it expires). Core
// decides who may purge and what; the audit log records who purged what
// and why, never what was removed.

const reasonLabels: Readonly<Record<PurgeReason, MessageDescriptor>> = {
  offboarding: msg`Someone left the organization`,
  erasure_request: msg`Someone asked for their data to be erased`,
  other: msg`Another reason`,
};

/** The terms as typed, one a line: each once, in the order typed. */
const termsOf = (text: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
  ),
];

/** Where the purge is: asked for, previewed, or done. */
type Stage =
  | { at: "form" }
  | { at: "plan"; input: PurgeInput; plan: PurgePlan }
  | { at: "done"; result: PurgeResult };

/** What the plan says the purge would remove, as counts. */
const PlanCounts = ({
  plan: { documents, versions, occurrences, memories, hostCopies, originals },
}: {
  plan: PurgePlan;
}) => (
  <ul className="flex flex-col gap-1 text-sm">
    <li>
      <Plural
        one="# document rewritten"
        other="# documents rewritten"
        value={documents}
      />
    </li>
    <li>
      <Plural
        one="# version rewritten"
        other="# versions rewritten"
        value={versions}
      />
    </li>
    <li>
      <Plural
        one="# occurrence removed"
        other="# occurrences removed"
        value={occurrences}
      />
    </li>
    <li>
      <Plural
        one="# memory record redacted or deleted"
        other="# memory records redacted or deleted"
        value={memories}
      />
    </li>
    <li>
      <Plural
        one="# copy outside Knowledge cleaned"
        other="# copies outside Knowledge cleaned"
        value={hostCopies}
      />
    </li>
    <li>
      <Plural
        one="# uploaded original deleted"
        other="# uploaded originals deleted"
        value={originals}
      />
    </li>
  </ul>
);

/** The terms, the reason and the documents: what to ask core about. */
const PurgeForm = ({
  documents,
  terms,
  reason,
  busy,
  onTerms,
  onReason,
}: {
  documents: number;
  terms: string;
  reason: PurgeReason;
  busy: boolean;
  onTerms: (terms: string) => void;
  onReason: (reason: PurgeReason) => void;
}) => {
  const { i18n } = useLingui();
  const ids = useId();
  const most = purgeMaxTerms;
  const first = purgeMaxDocuments;
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${ids}-terms`}>
          <Trans>What to remove</Trans>
        </FieldLabel>
        <Textarea
          disabled={busy}
          id={`${ids}-terms`}
          onChange={(event) => {
            onTerms(event.target.value);
          }}
          rows={5}
          value={terms}
        />
        <FieldDescription>
          <Trans>
            One a line, up to {most}: a name, each other form of it, an email
            address. A term is removed as a whole word, in any case, so list
            joined forms as terms of their own.
          </Trans>
        </FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">
          <Trans>Why</Trans>
        </FieldLegend>
        <RadioGroup
          disabled={busy}
          onValueChange={(value) => {
            const parsed = purgeReasonSchema.safeParse(value);
            if (parsed.success) {
              onReason(parsed.data);
            }
          }}
          value={reason}
        >
          {purgeReasonSchema.options.map((one) => (
            <Field key={one} orientation="horizontal">
              <RadioGroupItem id={`${ids}-${one}`} value={one} />
              <FieldContent>
                <FieldLabel htmlFor={`${ids}-${one}`}>
                  {i18n._(reasonLabels[one])}
                </FieldLabel>
              </FieldContent>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <p className="text-muted-foreground text-sm">
        {documents > purgeMaxDocuments ? (
          <Trans>
            From every version of the first {first} files of this collection;
            purge again for the rest.
          </Trans>
        ) : (
          <Plural
            one="From every version of this collection's # file."
            other="From every version of this collection's # files."
            value={documents}
          />
        )}
      </p>
    </>
  );
};

/** The plan, to confirm before it expires. */
const PlanView = ({ plan }: { plan: PurgePlan }) => {
  const until = formatDateTime(plan.expiresAt);
  const longer = plan.inLongerWords;
  return (
    <div className="flex flex-col gap-4">
      <PlanCounts plan={plan} />
      {longer > 0 ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>
            <Plural
              one="A term is still in # longer word or address."
              other="A term is still in # longer words or addresses."
              value={longer}
            />
          </AlertTitle>
          <AlertDescription>
            <Trans>
              A search for part of a word still finds those. Go back and add
              each such form as a term of its own.
            </Trans>
          </AlertDescription>
        </Alert>
      ) : null}
      <p className="text-muted-foreground text-sm">
        <Trans>
          This can&apos;t be undone. Confirm by {until}, or prepare it again.
        </Trans>
      </p>
    </div>
  );
};

/** What the purge removed, and what a search still finds. */
const ResultView = ({ result }: { result: PurgeResult }) => {
  const { documents, versions } = result;
  const still = result.stillFound ?? 0;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <ul className="flex flex-col gap-1">
        <li>
          <Plural
            one="# document purged"
            other="# documents purged"
            value={documents}
          />
        </li>
        <li>
          <Plural
            one="# version purged"
            other="# versions purged"
            value={versions}
          />
        </li>
      </ul>
      {still > 0 ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>
            <Plural
              one="A search still finds a term in # place."
              other="A search still finds a term in # places."
              value={still}
            />
          </AlertTitle>
          <AlertDescription>
            <Trans>
              A form spelled otherwise, or part of a longer word or address.
              Purge again with those forms as terms.
            </Trans>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};

/** The purge, from asking to done, a fresh one each time it opens. */
const PurgeFlow = ({
  collection,
  documents,
}: {
  collection: string;
  documents: readonly DocumentSummary[];
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [stage, setStage] = useState<Stage>({ at: "form" });
  const [terms, setTerms] = useState("");
  const [reason, setReason] = useState<PurgeReason>("erasure_request");
  const listed = termsOf(terms);
  const ready =
    listed.length > 0 && listed.length <= purgeMaxTerms && documents.length > 0;

  const prepare = async (): Promise<void> => {
    const input: PurgeInput = {
      type: "content",
      documentIds: documents.slice(0, purgeMaxDocuments).map(({ id }) => id),
      terms: listed,
      reason,
    };
    const plan = await run(
      async (session) => await session.knowledge.preparePurge(input)
    );
    if (plan !== undefined) {
      setStage({ at: "plan", input, plan });
    }
  };

  const confirm = async (input: PurgeInput, token: string): Promise<void> => {
    const result = await run(
      async (session) => await session.knowledge.purge(input, token)
    );
    if (result !== undefined) {
      setStage({ at: "done", result });
      // The documents read as they are now.
      await router.invalidate();
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (stage.at === "form" && ready && !busy) {
          void prepare();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>Purge personal data from {collection}</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Takes terms out of every version of the collection&apos;s documents,
            for good. You see what it would remove first.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      {stage.at === "form" ? (
        <PurgeForm
          busy={busy}
          documents={documents.length}
          onReason={setReason}
          onTerms={setTerms}
          reason={reason}
          terms={terms}
        />
      ) : null}
      {stage.at === "plan" ? <PlanView plan={stage.plan} /> : null}
      {stage.at === "done" ? <ResultView result={stage.result} /> : null}
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        {stage.at === "form" ? (
          <Button disabled={!ready || busy} type="submit">
            <Trans>Preview the purge</Trans>
          </Button>
        ) : null}
        {stage.at === "plan" ? (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                setStage({ at: "form" });
              }}
              type="button"
              variant="outline"
            >
              <Trans>Change the terms</Trans>
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                void confirm(stage.input, stage.plan.token);
              }}
              type="button"
              variant="destructive"
            >
              <Trans>Purge for good</Trans>
            </Button>
          </>
        ) : null}
        {stage.at === "done" ? (
          <Button
            onClick={() => {
              setStage({ at: "form" });
            }}
            type="button"
            variant="outline"
          >
            <Trans>Purge more</Trans>
          </Button>
        ) : null}
      </DialogFooter>
    </form>
  );
};

/**
 * The collection's menu for an admin of the organization: purging
 * personal data from it, previewed first.
 */
export const CollectionAdminMenu = ({
  collection,
  documents,
}: {
  collection: string;
  documents: readonly DocumentSummary[];
}) => {
  const { t } = useLingui();
  const [purging, setPurging] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={t`Collection actions`}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setPurging(true);
            }}
          >
            <UserXIcon />
            <Trans>Purge personal data</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog onOpenChange={setPurging} open={purging}>
        <DialogContent closeLabel={t`Close`}>
          {purging ? (
            <PurgeFlow collection={collection} documents={documents} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
};
