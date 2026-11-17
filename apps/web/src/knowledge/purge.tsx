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
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { More, Trash } from "../grasp/icons/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
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

const styles = stylex.create({
  stack: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  counts: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

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

/**
 * What the plan says the purge would remove, as counts: of the documents
 * named, and a person's own memory records for a personal purge. A
 * content purge also cleans everyone's memory records and Grasp's copies
 * of people's words, but counts none of them.
 */
const PlanCounts = ({
  plan: { documents, versions, occurrences, memories, originals },
}: {
  plan: PurgePlan;
}) => (
  <ul {...stylex.props(styles.counts)}>
    <li>
      <Text element="span" size="sm">
        <Plural
          one="# document rewritten"
          other="# documents rewritten"
          value={documents}
        />
      </Text>
    </li>
    <li>
      <Text element="span" size="sm">
        <Plural
          one="# version rewritten"
          other="# versions rewritten"
          value={versions}
        />
      </Text>
    </li>
    <li>
      <Text element="span" size="sm">
        <Plural
          one="# occurrence removed"
          other="# occurrences removed"
          value={occurrences}
        />
      </Text>
    </li>
    {memories === undefined ? null : (
      <li>
        <Text element="span" size="sm">
          <Plural
            one="# memory record redacted or deleted"
            other="# memory records redacted or deleted"
            value={memories}
          />
        </Text>
      </li>
    )}
    <li>
      <Text element="span" size="sm">
        <Plural
          one="# uploaded original deleted"
          other="# uploaded originals deleted"
          value={originals}
        />
      </Text>
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
  const { t, i18n } = useLingui();
  const most = purgeMaxTerms;
  const first = purgeMaxDocuments;
  return (
    <>
      <Field>
        <FieldLabel>{t`What to remove`}</FieldLabel>
        <Textarea
          disabled={busy}
          onValueChange={onTerms}
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
      <Field>
        <FieldLabel>{t`Why`}</FieldLabel>
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
              <RadioGroupItem value={one} />
              <FieldLabel>{i18n._(reasonLabels[one])}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </Field>
      <Text size="sm" tone="muted">
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
      </Text>
    </>
  );
};

/** The plan: what the purge would remove, to confirm before it expires. */
const PlanView = ({
  plan,
  kind,
}: {
  plan: PurgePlan;
  kind: PurgeInput["type"];
}) => {
  const { t } = useLingui();
  const longer = plan.inLongerWords;
  return (
    <div {...stylex.props(styles.stack)}>
      <PlanCounts plan={plan} />
      {longer > 0 ? (
        <Alert
          title={t`${plural(longer, {
            one: "A term is still in # longer word or address.",
            other: "A term is still in # longer words or addresses.",
          })}`}
          tone="attention"
        >
          <Trans>
            A search for part of a word still finds those. Go back and add each
            such form as a term of its own.
          </Trans>
        </Alert>
      ) : null}
      {kind === "content" ? (
        // A content purge's widest effect, said without a number: how many
        // of those hold a term is never counted (it would say what
        // someone's private records hold).
        <Text size="sm">
          <Trans>
            The terms also go from everyone&apos;s memory records, interviews
            and answers. How many of those hold them isn&apos;t counted or
            shown.
          </Trans>
        </Text>
      ) : null}
    </div>
  );
};

/** What the purge removed, and what a search still finds. */
const ResultView = ({ result }: { result: PurgeResult }) => {
  const { t } = useLingui();
  const { documents, versions } = result;
  const still = result.stillFound ?? 0;
  return (
    <div {...stylex.props(styles.stack)}>
      <ul {...stylex.props(styles.counts)}>
        <li>
          <Text element="span" size="sm">
            <Plural
              one="# document purged"
              other="# documents purged"
              value={documents}
            />
          </Text>
        </li>
        <li>
          <Text element="span" size="sm">
            <Plural
              one="# version purged"
              other="# versions purged"
              value={versions}
            />
          </Text>
        </li>
      </ul>
      {still > 0 ? (
        <Alert
          title={t`${plural(still, {
            one: "A search still finds a term in # place.",
            other: "A search still finds a term in # places.",
          })}`}
          tone="attention"
        >
          <Trans>
            A form spelled otherwise, or part of a longer word or address. Purge
            again with those forms as terms.
          </Trans>
        </Alert>
      ) : null}
    </div>
  );
};

/**
 * The last step, asked first: the purge can't be undone, and its plan
 * holds until `expiresAt`. `onConfirm` throws when core refused, so the
 * question stays open and says so.
 */
const ConfirmPurge = ({
  collection,
  expiresAt,
  busy,
  failure,
  onConfirm,
}: {
  collection: string;
  expiresAt: string;
  busy: boolean;
  failure: string | undefined;
  onConfirm: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const until = formatDateTime(expiresAt);
  return (
    <AlertDialog>
      <AlertDialogTrigger disabled={busy} size="sm" variant="danger">
        {t`Purge for good`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>
          {t`Purge personal data from ${collection} for good?`}
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>
            This can&apos;t be undone. Confirm by {until}, or prepare it again.
          </Trans>
        </AlertDialogDescription>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            action={onConfirm}
            failedLabel={t`Not purged`}
            variant="danger"
            workingLabel={t`Purging`}
          >
            {t`Purge for good`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const { t } = useLingui();
  const formId = useId();
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
    // Core refused, as `failure` says: the question stays open.
    if (result === undefined) {
      throw new Error("The purge was refused.");
    }
    setStage({ at: "done", result });
    // The documents read as they are now.
    await router.invalidate();
  };

  return (
    <>
      <DialogTitle>{t`Purge personal data from ${collection}`}</DialogTitle>
      <DialogDescription>
        <Trans>
          Takes terms out of every version of the collection&apos;s documents,
          for good. You see what it would remove first.
        </Trans>
      </DialogDescription>
      <DialogBody>
        <Form
          aria-label={t`Purge personal data from ${collection}`}
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (stage.at === "form" && ready && !busy) {
              void prepare();
            }
          }}
        >
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
          {stage.at === "plan" ? (
            <PlanView kind={stage.input.type} plan={stage.plan} />
          ) : null}
          {stage.at === "done" ? <ResultView result={stage.result} /> : null}
          <ErrorText>{failure}</ErrorText>
        </Form>
      </DialogBody>
      <DialogFooter>
        {stage.at === "form" ? (
          <Button
            disabled={!ready || busy}
            form={formId}
            size="sm"
            type="submit"
            variant="ink"
          >
            {t`Preview the purge`}
          </Button>
        ) : null}
        {stage.at === "plan" ? (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                setStage({ at: "form" });
              }}
              size="sm"
            >
              {t`Change the terms`}
            </Button>
            <ConfirmPurge
              busy={busy}
              collection={collection}
              expiresAt={stage.plan.expiresAt}
              failure={failure}
              onConfirm={async () => {
                await confirm(stage.input, stage.plan.token);
              }}
            />
          </>
        ) : null}
        {stage.at === "done" ? (
          <Button
            onClick={() => {
              setStage({ at: "form" });
            }}
            size="sm"
          >
            {t`Purge more`}
          </Button>
        ) : null}
      </DialogFooter>
    </>
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
          aria-label={t`Collection actions`}
          icon={More}
          size="sm"
          variant="ghost"
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            icon={Trash}
            onSelect={() => {
              setPurging(true);
            }}
            variant="danger"
          >
            {t`Purge personal data`}
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
