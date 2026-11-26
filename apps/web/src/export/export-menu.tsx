import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  DownloadIcon,
  FileDocIcon,
  FilePdfIcon,
  Icon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { exportAs } from "./export-file.tsx";
import type { ExportFile, ExportFormat } from "./export-file.tsx";

const styles = stylex.create({
  // Why the last export failed, beside the button that tries again.
  row: { display: "inline-flex", alignItems: "center", gap: space["2"] },
});

/**
 * Every export in Grasp, as in the prototype (`components/export-menu.tsx`):
 * a ghost button that is its icon alone, named by `label` in its tooltip,
 * and the person chooses Markdown or PDF.
 */
export const ExportMenu = ({
  file,
  label,
}: {
  file: ExportFile;
  /** What it exports, as the tooltip says it: "Export this chat". Plain "Export" without it. */
  label?: string;
}) => {
  const { i18n, t } = useLingui();
  const name = label ?? t`Export`;
  // While the page to print is being made (its styles and font), and why
  // an export failed, if one did.
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const exportIn = async (format: ExportFormat): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      await exportAs(file, format, i18n.locale);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };
  return (
    <span {...stylex.props(styles.row)}>
      {failed ? (
        <ErrorText>{t`The export didn't work. Try again.`}</ErrorText>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Its name shows as its tooltip; while the page is made, the spinner takes the icon's place. */}
          <Button
            aria-label={name}
            size="icon-sm"
            status={busy ? "loading" : "idle"}
            variant="ghost"
          >
            <Icon icon={DownloadIcon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            icon={FileDocIcon}
            onSelect={() => {
              void exportIn("md");
            }}
          >
            <Trans>Markdown (.md)</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={FilePdfIcon}
            onSelect={() => {
              void exportIn("pdf");
            }}
          >
            <Trans>PDF</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};
