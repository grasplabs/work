import { Button } from "@grasp-os/ui/components/button";
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
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Separator } from "@grasp-os/ui/components/separator";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";
import type { AddTo, Picks, Typed } from "./people-picks.ts";
import { typedOf } from "./people-picks.ts";
import {
  csvRows,
  exampleList,
  StaffListError,
  staffListOf,
  withListAdded,
} from "./staff-list.ts";
import { XlsxError, xlsxMost, xlsxRows } from "./xlsx.ts";

// Adding people the list doesn't have, on the leads step: someone the
// directory left out, a lead outside it, or everyone where no directory
// is connected. Addresses pasted (one or many, as a mail program copies
// them) into a team there is or a new one; or a staff list, a CSV or
// Excel file read in this browser, whose new people join those there are.
// What is wrong is said in the top bar, never in the dialog.

const styles = stylex.create({
  stack: { display: "grid", gap: space[5] },
  // "or" through the middle of a line either side.
  or: { display: "flex", alignItems: "center", gap: space[3] },
  orLine: { flexGrow: 1, flexBasis: 0, alignSelf: "center" },
  example: { justifySelf: "center" },
});

/** The value of the team choice that makes a new team. */
const newTeam = "__new";

const xlsxName = /\.xlsx$/iu;

/** A staff list read, added to the people there are; or why it could not be. */
const readList = async (
  file: File,
  noTeam: string,
  picks: Picks
): Promise<Picks | "headings" | "empty" | "large" | "unreadable"> => {
  if (file.size > xlsxMost.bytes) {
    return "large";
  }
  try {
    const rows = xlsxName.test(file.name)
      ? await xlsxRows(await file.arrayBuffer())
      : csvRows(await file.text());
    const read = staffListOf(rows, noTeam).roster;
    return withListAdded(read, picks.people.length === 0 ? null : picks);
  } catch (error) {
    if (error instanceof StaffListError || error instanceof XlsxError) {
      return error.reason;
    }
    return "unreadable";
  }
};

export const PeopleAdd = ({
  open,
  onOpenChange,
  picks,
  noTeam,
  onAdd,
  onList,
  text: given = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  picks: Picks;
  /** What the team for people without one is called. */
  noTeam: string;
  /** Addresses to add, and where; false when they could not be (said in the top bar). */
  onAdd: (typed: Typed[], to: AddTo) => boolean;
  /** The people with a staff list's new ones in. */
  onList: (picks: Picks, added: number) => void;
  /** Addresses to start from: the ones a search found not on the list. */
  text?: string;
}) => {
  const { t } = useLingui();
  const [text, setText] = useState(given);
  const [team, setTeam] = useState<string>(() => picks.teams[0]?.id ?? newTeam);
  const [named, setNamed] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const teams = picks.teams.toSorted((a, b) => a.name.localeCompare(b.name));
  const making = team === newTeam || teams.length === 0;
  const close = (next: boolean) => {
    if (!next) {
      setProblem(null);
    }
    onOpenChange(next);
  };
  const add = () => {
    const { typed, wrong } = typedOf(text);
    if (wrong.length > 0) {
      setProblem(
        t`These aren’t email addresses: ${formatList(wrong.slice(0, 5))}.`
      );
      return;
    }
    if (typed.length === 0) {
      setProblem(t`Paste one or more email addresses first.`);
      return;
    }
    const to: AddTo = making
      ? { newTeam: named.trim() === "" ? noTeam : named }
      : { team };
    if (onAdd(typed, to)) {
      setText("");
      setNamed("");
      close(false);
    }
  };
  const upload = async (file: File): Promise<void> => {
    setProblem(null);
    const read = await readList(file, noTeam, picks);
    if (typeof read !== "string") {
      onList(read, read.people.length - picks.people.length);
      close(false);
      return;
    }
    const why = {
      headings: t`I could not find the columns. The first row should name them: name, email, team and job.`,
      empty: t`There is nobody in this list.`,
      large: t`That’s more people than I can take: up to 2,000 in up to 120 teams.`,
      unreadable: t`I could not read this file. A CSV or an Excel file works.`,
    }[read];
    setProblem(why);
    throw new Error(why);
  };
  const teamItems = [
    ...teams.map((each) => ({ value: each.id, label: each.name })),
    { value: newTeam, label: t`A new team` },
  ];
  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Add people`}</DialogTitle>
          <DialogDescription>
            {t`Paste their work email addresses, as many as you like.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div {...stylex.props(styles.stack)}>
            <Field>
              <FieldLabel>{t`Email addresses`}</FieldLabel>
              <Textarea
                onValueChange={setText}
                placeholder={t`anna@company.com, tom@company.com`}
                rows={3}
                value={text}
              />
            </Field>
            {teams.length === 0 ? null : (
              <Field>
                <FieldLabel>{t`Team`}</FieldLabel>
                <Select
                  items={teamItems}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      setTeam(value);
                    }
                  }}
                  value={team}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </Field>
            )}
            {making ? (
              <Field>
                <FieldLabel>{t`Team name`}</FieldLabel>
                <Input
                  maxLength={80}
                  onValueChange={setNamed}
                  placeholder={t`For example Customer service`}
                  value={named}
                />
              </Field>
            ) : null}
            <div {...stylex.props(styles.or)}>
              <Separator style={styles.orLine} />
              <Text as="span" color="muted" size="sm">
                {t`or`}
              </Text>
              <Separator style={styles.orLine} />
            </div>
            <FileUpload
              accept={[".csv", ".tsv", ".txt", ".xlsx"]}
              description={t`A staff list as a CSV or Excel file, a row per person`}
              onUpload={upload}
            />
            <Button asChild size="sm" style={styles.example} variant="link">
              <a
                download="staff-list-example.csv"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(exampleList)}`}
              >
                {t`See an example`}
              </a>
            </Button>
          </div>
          {open ? <TopError>{problem}</TopError> : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button onClick={add}>{t`Add`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
