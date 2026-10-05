import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { DownloadIcon, FileTextIcon, PrinterIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
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
  className,
}: {
  file: ExportFile;
  /** What it exports, as the tooltip says it: "Export this chat". Plain "Export" without it. */
  label?: string;
  /** Placement only. */
  className?: string;
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
    <span className="inline-flex items-center gap-1.5">
      {failed ? (
        <ErrorText>{t`The export didn't work. Try again.`}</ErrorText>
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={name}
                    className={className}
                    disabled={busy}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              />
            }
          >
            {busy ? <Spinner /> : <DownloadIcon />}
          </TooltipTrigger>
          <TooltipContent>{name}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            onClick={() => {
              void exportIn("md");
            }}
          >
            <FileTextIcon />
            <Trans>Markdown (.md)</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              void exportIn("pdf");
            }}
          >
            <PrinterIcon />
            <Trans>PDF</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};
