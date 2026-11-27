import { failureText } from "@grasp-os/shared/errors";
import type { LinkToSend } from "@grasp-os/shared/onboarding";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { DataTable } from "@grasp-os/ui/components/data-table";
import type {
  DataTableColumn,
  DataTableRowAction,
} from "@grasp-os/ui/components/data-table";
import {
  Dialog,
  DialogBody,
  DialogClose,
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
import { Field, FieldError, FieldLabel } from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupClear,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Text } from "@grasp-os/ui/components/text";
import { toast } from "@grasp-os/ui/components/toast";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { DownloadIcon, Icon, SearchIcon } from "@grasp-os/ui/lib/icons";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { copyText } from "../copy.ts";
import { downloadCsv } from "../csv.ts";
import { fullLink, linksCsv } from "../onboarding/links-to-send.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { needsAdmin, statusRank } from "./interview-rows.ts";
import type { LinkRow, LinkStatus } from "./interview-rows.ts";
import { interviewStyles as styles } from "./interviews.styles.ts";
import { RowAlert, SettingsGroup } from "./section.tsx";

// Settings › Interviews › Links: everyone whose link is out, in one table,
// with what of it needs the admin first. Whose link mail failed for good
// (the campaign's `mail` asks): their address to put right, which sends it
// again (`onboarding.correctAddress`, only for a failed mail), or their
// link to hand over. And, where the deployment sends no mail
// (`OnboardingView.mailSends`), every link that is out and not sent yet
// (`LinkToSend.fresh`), to copy, send and mark as sent
// (`onboarding.linksTaken`). Core tells the admin nothing more of a link:
// not whether it was opened, nor whether its interview was held. A link is
// someone's own: it opens only once they sign in with the company's
// sign-in.

/** Which rows the table shows: what needs the admin, or every link that is out. */
export type LinksFilter = "attention" | "all";

/** How many links a page of the table holds. */
const pageSize = 25;

/** The address to correct, in a small dialog: core's refusal is said at the field. */
const AddressDialog = ({
  row,
  onClose,
  onChanged,
}: {
  row: LinkRow;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const formId = useId();
  const [address, setAddress] = useState(row.email);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const { name } = row;
  const send = async (): Promise<void> => {
    setBusy(true);
    setRefused(undefined);
    try {
      await core.withSession(async (session) => {
        await session.onboarding.correctAddress(row.person, address.trim());
      });
    } catch (error) {
      setRefused(failureText(error));
      setBusy(false);
      return;
    }
    // Sent: the mail is no longer one that failed, so the row leaves what needs the admin.
    onClose();
    await onChanged();
  };
  const title = t`Correct the address of ${name}`;
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t`Grasp puts it on the staff list and emails their link again.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Form
            aria-label={title}
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Field data-invalid={refused !== undefined}>
              <FieldLabel>{t`Email address`}</FieldLabel>
              <Input
                autoComplete="off"
                onValueChange={(value) => {
                  setAddress(value);
                  setRefused(undefined);
                }}
                required
                style={styles.fill}
                type="email"
                value={address}
              />
              <FieldError match="valueMissing">{t`Enter their email address.`}</FieldError>
              <FieldError match="typeMismatch">{t`Enter a whole email address.`}</FieldError>
              {refused === undefined ? null : (
                <FieldError match>{refused}</FieldError>
              )}
            </Field>
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button disabled={busy} form={formId} type="submit">
            {t`Send again`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Where the links stand, in one line at the card's foot. */
const useLinksLine = (links: readonly LinkToSend[]): string => {
  const { t } = useLingui();
  const all = links.length;
  const out = links.filter((link) => link.path !== null).length;
  const waiting = all - out;
  if (waiting === 0) {
    return plural(all, {
      one: "The one link is out.",
      other: "All # links are out.",
    });
  }
  return t`${out} of ${all} links are out. The others go out on their day, or once their team’s lead has talked.`;
};

/** The table's search and its filter, over it. */
const Toolbar = ({
  query,
  onQuery,
  filter,
  onFilter,
}: {
  query: string;
  onQuery: (query: string) => void;
  filter: LinksFilter;
  onFilter: (filter: LinksFilter) => void;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.toolbar)}>
      <InputGroup size="sm" style={styles.search}>
        <InputGroupAddon>
          <Icon icon={SearchIcon} />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t`Search links`}
          onValueChange={onQuery}
          placeholder={t`Search by name, team or email`}
          type="search"
          value={query}
        />
        <InputGroupClear aria-label={t`Clear search`} />
      </InputGroup>
      <ToggleGroup
        aria-label={t`Which links to show`}
        onValueChange={(pressed) => {
          // A press on the pressed one lifts nothing: one of the two always shows.
          const [next] = pressed;
          if (next === "attention" || next === "all") {
            onFilter(next);
          }
        }}
        size="sm"
        value={[filter]}
      >
        <ToggleGroupItem value="attention">{t`Needs attention`}</ToggleGroupItem>
        <ToggleGroupItem value="all">
          {t({ message: "All", context: "every link that is out" })}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
};

/** The table's columns: who, their team, their address, and where their link stands. */
const useColumns = (): DataTableColumn<LinkRow>[] => {
  const { t } = useLingui();
  const words: Record<LinkStatus, string> = {
    failed: t`Didn’t arrive`,
    send: t`To send`,
    sent: t`Sent`,
  };
  const variants = {
    failed: "destructive",
    send: "warning",
    sent: "secondary",
  } as const;
  return [
    { id: "name", header: t`Name`, value: (row) => row.name, sortable: true },
    { id: "team", header: t`Team`, value: (row) => row.team, sortable: true },
    {
      id: "email",
      header: t`Email`,
      value: (row) => row.email,
      cell: (row) =>
        row.email === "" ? (
          <Text as="span" color="muted" size="sm">{t`No email address`}</Text>
        ) : (
          row.email
        ),
      sortable: true,
    },
    {
      id: "status",
      header: t`Status`,
      value: (row) => statusRank(row.status),
      text: (row) => words[row.status],
      cell: (row) => (
        <Badge size="sm" variant={variants[row.status]}>
          {words[row.status]}
        </Badge>
      ),
      sortable: true,
    },
  ];
};

/** What the card says in the table's place when there is no row to show. */
const NoRows = ({
  filter,
  mailSends,
}: {
  filter: LinksFilter;
  mailSends: boolean;
}) => {
  const { t } = useLingui();
  let title = t`No link is out yet`;
  let words = t`A link shows here once it is out: on its person’s day, or once their team’s lead has talked.`;
  if (filter === "attention") {
    title = mailSends
      ? t`Every invitation was delivered.`
      : t`Every link that is out has been sent.`;
    words = mailSends
      ? t`No email failed. An address that doesn’t work shows here, to correct.`
      : t`A link that goes out later shows here, to send.`;
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle level={3}>{title}</EmptyTitle>
        <EmptyDescription>{words}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/** Everyone's link that is out: what needs the admin first, and what to do with each. */
export const InterviewLinks = ({
  rows,
  links,
  mailSends,
  filter,
  onFilter,
  onChanged,
}: {
  /** The table's rows (`linkRows`). */
  rows: readonly LinkRow[];
  links: readonly LinkToSend[];
  /** Whether the deployment sends mail: where it doesn't, every link goes out by hand. */
  mailSends: boolean;
  filter: LinksFilter;
  onFilter: (filter: LinksFilter) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [correcting, setCorrecting] = useState<LinkRow>();
  const columns = useColumns();
  const line = useLinksLine(links);
  const shown = filter === "attention" ? rows.filter(needsAdmin) : rows;
  const toSend = rows.filter((row) => row.status === "send");
  const selectedToSend = toSend.filter((row) => selection.includes(row.person));
  const markSent = async (people: string[]): Promise<void> => {
    await run(async (session) => {
      await session.onboarding.linksTaken(people);
    });
    setSelection([]);
    await onChanged();
  };
  const actionsOf = (row: LinkRow): DataTableRowAction[] => {
    const { path, person } = row;
    return [
      ...(row.status === "failed"
        ? [
            {
              label: t`Correct the address`,
              onSelect: () => {
                setCorrecting(row);
              },
            },
          ]
        : []),
      ...(path === null
        ? []
        : [
            {
              label: t`Copy link`,
              onSelect: () => {
                void (async () => {
                  const copied = await copyText(
                    fullLink(path, window.location.origin)
                  );
                  if (copied) {
                    toast.success(t`Link copied`);
                  } else {
                    toast.error(t`Copying didn't work`);
                  }
                })();
              },
            },
          ]),
      ...(row.status === "send"
        ? [
            {
              label: t`Mark as sent`,
              onSelect: () => {
                void markSent([person]);
              },
            },
          ]
        : []),
    ];
  };
  return (
    <SettingsGroup
      actions={
        mailSends ? undefined : (
          <>
            {selection.length === 0 ? null : (
              <Button
                disabled={busy || selectedToSend.length === 0}
                onClick={() => {
                  void markSent(selectedToSend.map(({ person }) => person));
                }}
                size="sm"
                variant="outline"
              >
                {t`Mark selected as sent`}
              </Button>
            )}
            {toSend.length === 0 ? null : (
              <Button
                onClick={() => {
                  downloadCsv(
                    linksCsv(
                      links.filter((link) =>
                        toSend.some(({ person }) => person === link.person)
                      ),
                      window.location.origin,
                      [t`Name`, t`Email`, t`Team`, t`Link`]
                    ),
                    "grasp-links.csv"
                  );
                }}
                size="sm"
                variant="ghost"
              >
                <Icon icon={DownloadIcon} />
                {t`Download CSV`}
              </Button>
            )}
          </>
        )
      }
      description={
        mailSends
          ? t`Grasp emails everyone their own link. Here is what still needs you.`
          : t`Grasp sends no email here, so every link goes out by you: copy it, send it, then mark it as sent.`
      }
      flush
      footer={
        links.length === 0 ? undefined : (
          <Text color="muted" size="xs">
            {line}
          </Text>
        )
      }
      title={t`Links`}
    >
      {failure === undefined ? null : (
        <RowAlert variant="destructive">{failure}</RowAlert>
      )}
      {rows.length === 0 ? null : (
        <Toolbar
          filter={filter}
          onFilter={onFilter}
          onQuery={setQuery}
          query={query}
        />
      )}
      {shown.length === 0 ? (
        <NoRows filter={filter} mailSends={mailSends} />
      ) : (
        <DataTable
          aria-label={t`Links`}
          columns={columns}
          getRowId={(row) => row.person}
          onQueryChange={setQuery}
          onSelectionChange={setSelection}
          pageSize={pageSize}
          query={query}
          rowActions={actionsOf}
          rows={shown}
          selectable={!mailSends}
          selection={selection}
          unit={{ one: t`link`, other: t`links` }}
        />
      )}
      {correcting === undefined ? null : (
        <AddressDialog
          onChanged={onChanged}
          onClose={() => {
            setCorrecting(undefined);
          }}
          row={correcting}
        />
      )}
    </SettingsGroup>
  );
};
