// Concept C for Ruben (concept branch only, never merged): a note opens in
// a sheet over the map, so the brain stays in view; its connections switch
// the sheet, and only "Open the page" leaves the map.
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import type { Brain, Note } from "./brain.ts";

/** The notes a note is connected to, both ways, each once: no statements or sources. */
const connectedTo = (note: Note, brain: Brain): Note[] => {
  const ids = new Set([...note.links, ...note.backlinks]);
  return brain.notes.filter(
    (each) =>
      ids.has(each.id) &&
      each.id !== note.id &&
      each.kind !== "statement" &&
      each.kind !== "company"
  );
};

export const NotePeek = ({
  brain,
  noteId,
  onPeek,
  onClose,
}: {
  brain: Brain;
  noteId: string | undefined;
  onPeek: (noteId: string) => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const note = brain.notes.find((each) => each.id === noteId);
  const connected = note === undefined ? [] : connectedTo(note, brain);
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={note !== undefined}
      side="end"
    >
      <SheetContent>
        <SheetTitle>{note?.title ?? ""}</SheetTitle>
        {note?.summary === undefined ? null : (
          <SheetDescription>{note.summary}</SheetDescription>
        )}
        <SheetBody>
          {connected.length > 0 ? (
            <section>
              <SectionHeader size="sm" title={t`Connected to`} />
              <ItemGroup separated>
                {connected.map((each) => (
                  <Item
                    key={each.id}
                    render={
                      <button
                        aria-label={each.title}
                        onClick={() => {
                          onPeek(each.id);
                        }}
                        type="button"
                      />
                    }
                    size="sm"
                  >
                    <ItemContent>
                      <ItemTitle>{each.title}</ItemTitle>
                      {each.summary === undefined ? null : (
                        <ItemDescription>{each.summary}</ItemDescription>
                      )}
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </section>
          ) : null}
        </SheetBody>
        {note === undefined ? null : (
          <SheetFooter>
            <Button
              render={<Link params={{ noteId: note.id }} to="/brain/$noteId" />}
              variant="ink"
            >
              {t`Open the page`}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
};
