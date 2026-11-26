import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { toast } from "@grasp-os/ui/components/toast";
import {
  DownloadIcon,
  FileDocIcon,
  FilePdfIcon,
  Icon,
} from "@grasp-os/ui/lib/icons";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { exportAs } from "./export-file.tsx";
import type { ExportFile, ExportFormat } from "./export-file.tsx";

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
  // While the page to print is being made (its styles and font): one
  // export at a time. A failure is a toast, as the "…" menu's downloads
  // say it (brain/note-actions.tsx).
  const [busy, setBusy] = useState(false);
  const exportIn = async (format: ExportFormat): Promise<void> => {
    setBusy(true);
    try {
      await exportAs(file, format, i18n.locale);
    } catch {
      toast.error(t`The export didn't work. Try again.`);
    }
    setBusy(false);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
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
  );
};
