// Concepts for Ruben, round 2 of a note's page (concept branch only, never
// merged). The page has the card's whole room (frame/page-fill.ts `room`),
// so a side panel stands flush with the bar, the card's end and its foot.
//   1  the inspector as the library seats it: shown, with its views
//   2  the same inspector on request: closed until "Details" opens it
//   3  no panel: the details in the page, the timeline in a sheet
// Each starts with the head band: the page's full width, one line across
// it, the library's dither behind.
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { useChatLayout } from "../chat/chat-layout.ts";
import { formatDay } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Clock, Info } from "../grasp/icons/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { PanelSection } from "../grasp/panel-section/index.ts";
import {
  Panel,
  PanelHeader,
  PanelTexture,
  PanelView,
} from "../grasp/panel/index.ts";
import { RowList, RowListItem } from "../grasp/row-list/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import type { Note, NoteEvent } from "./brain.ts";

/** Where the window has room for the panel beside the note. */
const WIDE = media.fromRail;
const WIDE_QUERY = WIDE.replace("@media ", "");

/** A row of the note's details, as the page works them out. */
export interface ConceptRow {
  label: string;
  refs: readonly { label: string; to?: string | undefined }[];
}

const styles = stylex.create({
  // The note and its panel, the card's whole height; each scrolls alone.
  frame: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    flexGrow: 1,
    minHeight: 0,
  },
  framePanel: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
    },
  },
  main: { minWidth: 0, minHeight: 0, overflowY: "auto" },
  // The head band: the page's full width, flush under the bar, the dither
  // behind the note's title, its line and its actions.
  band: {
    position: "relative",
    overflow: "hidden",
  },
  // The band's own column, the page's measure, so the title stands on the
  // same start as what follows.
  bandColumn: {
    position: "relative",
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageColumnMeasure,
    marginInline: "auto",
    paddingBlock: grasp.space8,
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  // Its one line, along the band's foot from edge to edge.
  line: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    height: grasp.hairline,
    backgroundColor: grasp.line,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageColumnMeasure,
    marginInline: "auto",
    paddingTop: grasp.space6,
    paddingBottom: grasp.space24,
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  // The panel's place: the card's end, its whole height, one hairline toward the page.
  side: {
    display: { default: "none", [WIDE]: "flex" },
    minHeight: 0,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  panel: { flexGrow: 1, minHeight: 0 },
});

/** The note's details and timeline as the library's inspector: views in a title-less head. */
const NoteInspector = ({
  rows,
  timeline,
  framed,
  onClose,
}: {
  rows: readonly ConceptRow[];
  timeline: readonly NoteEvent[];
  framed: boolean;
  onClose?: (() => void) | undefined;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  return (
    <Panel
      aria-label={t`Details`}
      defaultView="details"
      framed={framed}
      layout={styles.panel}
    >
      <PanelHeader
        closeLabel={t`Close`}
        views={[
          { value: "details", label: t`Details`, icon: Info },
          { value: "timeline", label: t`Timeline`, icon: Clock },
        ]}
        viewsLabel={t`Details`}
        {...(onClose === undefined ? {} : { onClose })}
      />
      <PanelView value="details">
        {rows.map((row) => (
          <PanelSection key={row.label} label={row.label}>
            <RowList>
              {row.refs.map((ref, at) => (
                <RowListItem
                  key={`${ref.to ?? ref.label}-${at}`}
                  name={ref.label}
                  {...(ref.to === undefined
                    ? {}
                    : {
                        onPress: () => {
                          void navigate({
                            to: "/brain/$noteId",
                            params: { noteId: ref.to ?? "" },
                          });
                        },
                      })}
                />
              ))}
            </RowList>
          </PanelSection>
        ))}
      </PanelView>
      <PanelView value="timeline">
        {timeline.length === 0 ? (
          <PanelSection empty={t`Nothing happened yet`} label={t`Timeline`} />
        ) : (
          <PanelSection label={t`Timeline`}>
            <RowList>
              {timeline.map((entry, index) => (
                <RowListItem
                  detail={formatDay(entry.date)}
                  key={`${entry.date}-${index}`}
                  name={entry.title}
                />
              ))}
            </RowList>
          </PanelSection>
        )}
      </PanelView>
    </Panel>
  );
};

export const NotePageTwo = ({
  option,
  note,
  rows,
  timeline,
  actions,
  children,
}: {
  option: "1" | "2" | "3";
  note: Note;
  rows: readonly ConceptRow[];
  /** The note's timeline as the page draws it, for option 3's sheet. */
  timeline: ReactNode;
  /** Show in the brain and the download, as quiet icons. */
  actions: ReactNode;
  /** The note's own content. */
  children: ReactNode;
}) => {
  const { t } = useLingui();
  // Option 1 shows the panel; option 2 opens it on request.
  const [docked, setDocked] = useState(option === "1");
  const [sheet, setSheet] = useState(false);
  const panel = option !== "3";
  // The chat docked at the card's end takes that side: the panel steps
  // aside while it is there, and comes back when the chat closes or floats.
  const chat = useChatLayout();
  const chatDocked = chat.open && chat.placement === "docked";
  const besidePage = panel && docked && !chatDocked;
  const showDetails = () => {
    if (window.matchMedia(WIDE_QUERY).matches && !chatDocked) {
      setDocked(!docked);
    } else {
      setSheet(true);
    }
  };
  return (
    <div {...stylex.props(styles.frame, besidePage && styles.framePanel)}>
      <div {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.band)}>
          <PanelTexture />
          <span aria-hidden="true" {...stylex.props(styles.line)} />
          <div {...stylex.props(styles.bandColumn)}>
            <PageHeader
              actions={
                <>
                  {panel ? (
                    <Button
                      icon={Info}
                      onClick={showDetails}
                      size="sm"
                      variant="ghost"
                    >
                      {t`Details`}
                    </Button>
                  ) : (
                    <Button
                      icon={Clock}
                      onClick={() => {
                        setSheet(true);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {t`Timeline`}
                    </Button>
                  )}
                  {actions}
                </>
              }
              description={note.summary}
              title={note.title}
            />
          </div>
        </div>
        <div {...stylex.props(styles.column)}>
          {option === "3" && rows.length > 0 ? (
            <KeyValueList
              divided
              items={rows.map((row) => ({
                key: row.label,
                value: row.refs.map((ref) => ref.label).join(", "),
              }))}
            />
          ) : null}
          {children}
        </div>
      </div>
      {besidePage ? (
        <div {...stylex.props(styles.side)}>
          <NoteInspector framed={false} rows={rows} timeline={note.timeline} />
        </div>
      ) : null}
      <Sheet onOpenChange={setSheet} open={sheet} side="end">
        <SheetContent>
          {panel ? (
            <>
              <SheetTitle hidden>{t`Details`}</SheetTitle>
              <NoteInspector
                framed={false}
                rows={rows}
                timeline={note.timeline}
              />
            </>
          ) : (
            <>
              <SheetTitle>{t`Timeline`}</SheetTitle>
              <SheetBody>{timeline}</SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
};
