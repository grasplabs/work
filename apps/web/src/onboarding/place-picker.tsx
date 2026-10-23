import { placeErrors } from "@grasp-os/shared/document-places";
import type {
  DocumentPlace,
  PlaceItem,
  PlacesSuite,
} from "@grasp-os/shared/document-places";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  BuildingIcon,
  ChevronRightIcon,
  CloudIcon,
  FileTextIcon,
  FolderIcon,
  HardDriveIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { useCore } from "../use-core.ts";
import { extensionOf, readable } from "./document-files.ts";

// Where the admin picks documents in the place they live (GRA-370): the
// places the documents connection reaches (their OneDrive and the
// SharePoint sites, or their My Drive and the shared drives), the folders
// in one, or a search of it, and a box by each file that can be read.
// Only names are listed here; a file is fetched once it is added, by core,
// and read as a dropped one is. What is picked stays picked while the
// admin moves between folders.

/** A file the admin picked, to share. */
export interface PickedFile {
  place: string;
  item: string;
  name: string;
  size: number | null;
}

/** Where in a place the picker is: its top, a folder in it, or a search of it. */
interface Spot {
  place: DocumentPlace;
  /** The folders opened from the place's top, in order. */
  trail: { id: string; name: string }[];
  query: string | null;
}

/** What the picker shows: still loading, what it read, or why it couldn't. */
type Shown =
  | { state: "loading" }
  | { state: "places"; places: DocumentPlace[] }
  | { state: "items"; items: PlaceItem[]; next: string | null }
  | { state: "failed"; reconnect: boolean };

const placeIcons: Record<DocumentPlace["kind"], LucideIcon> = {
  onedrive: CloudIcon,
  site: BuildingIcon,
  "my-drive": HardDriveIcon,
  "shared-drive": UsersIcon,
};

/** Whether a file can be shared as a document, as a dropped one can be. */
const isReadable = (item: PlaceItem): boolean =>
  readable.some((extension) => extension === extensionOf(item.name));

/** Whether a read failed for a connection that must be connected again. */
const needsReconnecting = (error: unknown): boolean => {
  const code = placeErrors.codeOf(error);
  return code === "place.inactive" || code === "place.not_connected";
};

const PlaceRow = ({
  place,
  onOpen,
}: {
  place: DocumentPlace;
  onOpen: () => void;
}) => {
  const Icon = placeIcons[place.kind];
  return (
    <li className="border-b last:border-b-0">
      <button
        className="hover:bg-muted focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left outline-none focus-visible:ring-3"
        onClick={onOpen}
        type="button"
      >
        <Icon aria-hidden="true" className="text-muted-foreground size-4" />
        <span className="min-w-0 flex-1 truncate">{place.name}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className="text-muted-foreground size-4"
        />
      </button>
    </li>
  );
};

const ItemRow = ({
  item,
  picked,
  onOpen,
  onPick,
}: {
  item: PlaceItem;
  picked: boolean;
  onOpen: () => void;
  onPick: (pick: boolean) => void;
}) => {
  const { t } = useLingui();
  if (item.kind === "folder") {
    return (
      <li className="border-b last:border-b-0">
        <button
          className="hover:bg-muted focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left outline-none focus-visible:ring-3"
          onClick={onOpen}
          type="button"
        >
          <FolderIcon
            aria-hidden="true"
            className="text-muted-foreground size-4"
          />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <ChevronRightIcon
            aria-hidden="true"
            className="text-muted-foreground size-4"
          />
        </button>
      </li>
    );
  }
  const can = isReadable(item);
  return (
    <li className="border-b last:border-b-0">
      <label className="flex min-h-11 items-center gap-3 px-3 py-2 has-disabled:opacity-60">
        <Checkbox checked={picked} disabled={!can} onCheckedChange={onPick} />
        <FileTextIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 flex-none"
        />
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        {can ? null : (
          <span className="text-muted-foreground flex-none text-xs">{t`Can’t be read`}</span>
        )}
      </label>
    </li>
  );
};

/** A step back in the trail, as a breadcrumb's link: it opens that place or folder again. */
const Crumb = ({
  children,
  onClick,
}: {
  children: string;
  onClick: () => void;
}) => (
  <BreadcrumbLink
    render={<button aria-label={children} onClick={onClick} type="button" />}
  >
    {children}
  </BreadcrumbLink>
);

/** The search of a place: by name and content, sent with Enter; empty, its folder again. */
const SearchPlace = ({
  name,
  value,
  onChange,
  onSearch,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(value.trim());
      }}
    >
      <InputGroup>
        <InputGroupInput
          aria-label={t`Search ${name}`}
          maxLength={120}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          placeholder={t`Search ${name}`}
          value={value}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
};

/** What the picker shows while it is open: mounted on each opening, so it starts at the places with nothing picked. */
const PickerBody = ({
  onClose,
  onAdd,
  onReconnect,
}: {
  onClose: () => void;
  onAdd: (files: PickedFile[]) => void;
  onReconnect: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [spot, setSpot] = useState<Spot | null>(null);
  const [shown, setShown] = useState<Shown>({ state: "loading" });
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Map<string, PickedFile>>(new Map());
  // Each read is numbered: one answered after a later one began is dropped.
  const reads = useRef(0);
  const loadPlaces = async () => {
    reads.current += 1;
    const read = reads.current;
    setSpot(null);
    setShown({ state: "loading" });
    try {
      const places = await core.withSession(
        async (session) => await session.onboarding.listDocumentPlaces()
      );
      if (read === reads.current) {
        setShown({ state: "places", places });
      }
    } catch (error) {
      if (read === reads.current) {
        setShown({ state: "failed", reconnect: needsReconnecting(error) });
      }
    }
  };
  const loadItems = async (at: Spot, cursor: string | null = null) => {
    reads.current += 1;
    const read = reads.current;
    setSpot(at);
    if (cursor === null) {
      setShown({ state: "loading" });
    } else {
      setMore(true);
    }
    try {
      const page = await core.withSession(
        async (session) =>
          await session.onboarding.placeItems({
            place: at.place.id,
            folder: at.trail.at(-1)?.id ?? null,
            query: at.query,
            cursor,
          })
      );
      if (read === reads.current) {
        setShown((now) => ({
          state: "items",
          items:
            cursor !== null && now.state === "items"
              ? [...now.items, ...page.items]
              : page.items,
          next: page.next,
        }));
      }
    } catch (error) {
      if (read === reads.current) {
        setShown({ state: "failed", reconnect: needsReconnecting(error) });
      }
    }
    if (read === reads.current) {
      setMore(false);
    }
  };
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void loadPlaces();
    }
  });
  const pick = (item: PlaceItem, on: boolean) => {
    if (spot === null) {
      return;
    }
    const { place } = spot;
    setPicked((now) => {
      const next = new Map(now);
      const key = `${place.id}/${item.id}`;
      if (on) {
        next.set(key, {
          place: place.id,
          item: item.id,
          name: item.name,
          size: item.size,
        });
      } else {
        next.delete(key);
      }
      return next;
    });
  };
  const count = picked.size;
  let empty: string | null = null;
  if (shown.state === "items" && shown.items.length === 0) {
    empty = spot?.query === null ? t`Nothing here` : t`Nothing found`;
  } else if (shown.state === "places" && shown.places.length === 0) {
    empty = t`Nothing here`;
  }
  return (
    <>
      <div className="flex min-w-0 flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem key="places">
              {spot === null ? (
                <BreadcrumbPage>{t`Places`}</BreadcrumbPage>
              ) : (
                <Crumb
                  onClick={() => {
                    setSearch("");
                    void loadPlaces();
                  }}
                >
                  {t`Places`}
                </Crumb>
              )}
            </BreadcrumbItem>
            {spot === null
              ? null
              : [{ id: null, name: spot.place.name }, ...spot.trail].map(
                  (step, at, all) => (
                    <Fragment key={step.id ?? spot.place.id}>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        {at === all.length - 1 && spot.query === null ? (
                          <BreadcrumbPage>{step.name}</BreadcrumbPage>
                        ) : (
                          <Crumb
                            onClick={() => {
                              setSearch("");
                              void loadItems({
                                place: spot.place,
                                trail: spot.trail.slice(0, at),
                                query: null,
                              });
                            }}
                          >
                            {step.name}
                          </Crumb>
                        )}
                      </BreadcrumbItem>
                    </Fragment>
                  )
                )}
          </BreadcrumbList>
        </Breadcrumb>
        {spot === null ? null : (
          <SearchPlace
            name={spot.place.name}
            onSearch={(query) => {
              void loadItems({
                place: spot.place,
                trail: query === "" ? spot.trail : [],
                query: query === "" ? null : query,
              });
            }}
            onChange={setSearch}
            value={search}
          />
        )}
        <div className="h-72 overflow-y-auto rounded-lg border">
          {shown.state === "loading" ? (
            <div className="flex h-full items-center justify-center">
              <Spinner aria-label={t`Loading`} />
            </div>
          ) : null}
          {shown.state === "failed" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-muted-foreground text-balance">
                {shown.reconnect
                  ? t`This connection needs to be connected again.`
                  : t`I could not open this just now. Try again in a moment.`}
              </p>
              {shown.reconnect ? (
                <Button onClick={onReconnect} size="sm" variant="outline">
                  {t`Connect again`}
                </Button>
              ) : null}
            </div>
          ) : null}
          {empty === null ? null : (
            <p className="text-muted-foreground flex h-full items-center justify-center p-6">
              {empty}
            </p>
          )}
          {shown.state === "places" ? (
            <ul className="p-1">
              {shown.places.map((place) => (
                <PlaceRow
                  key={place.id}
                  onOpen={() => {
                    void loadItems({ place, trail: [], query: null });
                  }}
                  place={place}
                />
              ))}
            </ul>
          ) : null}
          {shown.state === "items" && spot !== null ? (
            <ul className="p-1">
              {shown.items.map((item) => (
                <ItemRow
                  item={item}
                  key={item.id}
                  onOpen={() => {
                    setSearch("");
                    void loadItems({
                      place: spot.place,
                      trail: [
                        ...(spot.query === null ? spot.trail : []),
                        { id: item.id, name: item.name },
                      ],
                      query: null,
                    });
                  }}
                  onPick={(on) => {
                    pick(item, on);
                  }}
                  picked={picked.has(`${spot.place.id}/${item.id}`)}
                />
              ))}
              {shown.next === null ? null : (
                <li className="flex justify-center p-2">
                  <Button
                    disabled={more}
                    onClick={() => {
                      void loadItems(spot, shown.next);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {more ? <Spinner data-icon="inline-start" /> : null}
                    {t`Show more`}
                  </Button>
                </li>
              )}
            </ul>
          ) : null}
        </div>
      </div>
      <DialogFooter>
        <Button onClick={onClose} variant="outline">
          {t`Cancel`}
        </Button>
        <Button
          disabled={count === 0}
          onClick={() => {
            onAdd([...picked.values()]);
          }}
        >
          {t`${plural(count, { one: "Add # document", other: "Add # documents" })}`}
        </Button>
      </DialogFooter>
    </>
  );
};

/** The picker's dialog, for `suite`'s places. */
export const PlacePicker = ({
  suite,
  open,
  onOpenChange,
  onAdd,
  onReconnect,
}: {
  suite: PlacesSuite;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (files: PickedFile[]) => void;
  onReconnect: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-svh sm:max-w-lg" closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>{t`Choose documents`}</DialogTitle>
          <DialogDescription>
            {suite === "microsoft"
              ? t`From SharePoint or OneDrive. I read only the files you add.`
              : t`From Google Drive. I read only the files you add.`}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <PickerBody
            onAdd={onAdd}
            onClose={() => {
              onOpenChange(false);
            }}
            onReconnect={onReconnect}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
