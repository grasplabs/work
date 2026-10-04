import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { DownloadIcon, FileTextIcon, PrinterIcon } from "lucide-react";

import { exportAs } from "./export-file.tsx";
import type { ExportFile } from "./export-file.tsx";

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
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={name}
                  className={className}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          <DownloadIcon />
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onClick={() => {
            void exportAs(file, "md", i18n.locale);
          }}
        >
          <FileTextIcon />
          <Trans>Markdown (.md)</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            void exportAs(file, "pdf", i18n.locale);
          }}
        >
          <PrinterIcon />
          <Trans>PDF</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
