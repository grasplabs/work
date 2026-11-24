import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  CheckIcon,
  DownloadIcon,
  Icon,
  TableIcon,
} from "@grasp-os/ui/lib/icons";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { downloadText } from "../export/export-file.tsx";
import { tableAs, tablesOf } from "./answer-tables.ts";
import type { AnswerTable, TableFormat } from "./answer-tables.ts";

// Copy a table of the answer as Markdown, CSV or TSV, or download it as
// CSV or Markdown, all in the browser: what main's chat offered over each
// table. Damsko's Markdown draws the tables and takes no actions on one
// (findings/damsko-registry-gaps.md), so they stand in the answer's own
// actions, a group for each table where it has more than one.

/** How long the copy menu's mark says it copied. */
const copiedMs = 1500;

/** Saves `table` as `format` in the person's downloads. */
const download = (table: AnswerTable, format: TableFormat): void => {
  const [extension, type] =
    format === "csv" ? ["csv", "text/csv"] : ["md", "text/markdown"];
  downloadText(`table.${extension}`, tableAs(table.rows, format), type);
};

/** A table's items, under its name where the menu holds more than one. */
const TableGroup = ({
  name,
  several,
  children,
}: {
  name: string;
  several: boolean;
  children: ReactNode;
}) => (
  <DropdownMenuGroup>
    {several ? <DropdownMenuLabel>{name}</DropdownMenuLabel> : null}
    {children}
  </DropdownMenuGroup>
);

/** Copying one table, as each format; the menu waits while it copies, and says so where the browser refuses. */
const CopyItems = ({
  table,
  onCopied,
}: {
  table: AnswerTable;
  onCopied: () => void;
}) => {
  const { t } = useLingui();
  const copy = async (format: TableFormat): Promise<void> => {
    await navigator.clipboard.writeText(tableAs(table.rows, format));
    onCopied();
  };
  const notCopied = t`Not copied`;
  return (
    <>
      <DropdownMenuItem
        errorText={notCopied}
        onSelect={async () => {
          await copy("markdown");
        }}
      >
        <Trans>Copy table as Markdown</Trans>
      </DropdownMenuItem>
      <DropdownMenuItem
        errorText={notCopied}
        onSelect={async () => {
          await copy("csv");
        }}
      >
        <Trans>Copy table as CSV</Trans>
      </DropdownMenuItem>
      <DropdownMenuItem
        errorText={notCopied}
        onSelect={async () => {
          await copy("tsv");
        }}
      >
        <Trans>Copy table as TSV</Trans>
      </DropdownMenuItem>
    </>
  );
};

/** Downloading one table, as each format. */
const DownloadItems = ({ table }: { table: AnswerTable }) => (
  <>
    <DropdownMenuItem
      onSelect={() => {
        download(table, "csv");
      }}
    >
      <Trans>Download table as CSV</Trans>
    </DropdownMenuItem>
    <DropdownMenuItem
      onSelect={() => {
        download(table, "markdown");
      }}
    >
      <Trans>Download table as Markdown</Trans>
    </DropdownMenuItem>
  </>
);

/** The answer's table actions, beside Copy: none for an answer without a table. */
export const AnswerTableActions = ({ text }: { text: string }) => {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = copied
      ? setTimeout(() => {
          setCopied(false);
        }, copiedMs)
      : undefined;
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const tables = tablesOf(text).map((table, index) => ({
    table,
    // The tables of a kept answer never move: their place is their key.
    key: index,
    name: table.name ?? t`Table ${index + 1}`,
  }));
  if (tables.length === 0) {
    return null;
  }
  const several = tables.length > 1;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={t`Copy table`} size="icon-sm" variant="ghost">
            <Icon icon={copied ? CheckIcon : TableIcon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {tables.map(({ table, key, name }) => (
            <TableGroup key={key} name={name} several={several}>
              <CopyItems
                onCopied={() => {
                  setCopied(true);
                }}
                table={table}
              />
            </TableGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={t`Download table`} size="icon-sm" variant="ghost">
            <Icon icon={DownloadIcon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {tables.map(({ table, key, name }) => (
            <TableGroup key={key} name={name} several={several}>
              <DownloadItems table={table} />
            </TableGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};
