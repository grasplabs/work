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
} from "@grasp-os/ui/components/breadcrumb";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Text } from "@grasp-os/ui/components/text";
import {
  BuildingIcon,
  ChevronRightIcon,
  CircleUserIcon,
  FolderIcon,
  Icon,
  SearchIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { useCore } from "../use-core.ts";
import { extensionOf, readable } from "./document-files.ts";

const styles = stylex.create({
  picker: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    minWidth: 0,
  },
  // One height whatever it shows, so the dialog does not jump between folders.
  box: {
    height: "18rem",
    overflowY: "auto",
    paddingInline: space[3],
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.base,
    cornerShape: radius.shape,
  },
  centred: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space[3],
    height: "100%",
    padding: space[6],
    textAlign: "center",
  },
  // A file: its box and its name, a line over each but the first, as the list's rows have.
  file: {
    display: "flex",
    alignItems: "center",
    minHeight: size.tapTarget,
    borderBlockStartWidth: { default: size.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  more: { display: "flex", justifyContent: "center", padding: space[2] },
});

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

const placeIcons: Record<DocumentPlace["kind"], IconData> = {
  onedrive: CircleUserIcon,
  site: BuildingIcon,
  "my-drive": CircleUserIcon,
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

/** A place or a folder: the whole row opens it. */
const OpenRow = ({
  icon,
  name,
  onOpen,
}: {
  icon: IconData;
  name: string;
  onOpen: () => void;
}) => (
  <Item onClick={onOpen} size="sm">
    <ItemMedia>
      <Icon icon={icon} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{name}</ItemTitle>
    </ItemContent>
    <ItemDetail>
      <Icon icon={ChevronRightIcon} />
    </ItemDetail>
  </Item>
);

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
    return <OpenRow icon={FolderIcon} name={item.name} onOpen={onOpen} />;
  }
  const can = isReadable(item);
  return (
    <li {...stylex.props(styles.file)}>
      <Field disabled={!can} orientation="horizontal">
        <Checkbox
          checked={picked}
          onCheckedChange={(checked) => {
            onPick(checked === true);
          }}
        />
        <FieldContent>
          <FieldLabel>{item.name}</FieldLabel>
          {can ? null : <FieldDescription>{t`Can’t be read`}</FieldDescription>}
        </FieldContent>
      </Field>
    </li>
  );
};

/** The next page of a folder, at the foot of its list. */
const MoreRow = ({
  loading,
  onMore,
}: {
  loading: boolean;
  onMore: () => void;
}) => {
  const { t } = useLingui();
  const words = t`Show more`;
  return (
    <li {...stylex.props(styles.more)}>
      <Button
        disabled={loading}
        successText={words}
        errorText={words}
        onClick={onMore}
        size="sm"
        status={loading ? "loading" : "idle"}
        variant="ghost"
      >
        {words}
      </Button>
    </li>
  );
};

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
      <Input
        aria-label={t`Search ${name}`}
        icon={SearchIcon}
        maxLength={120}
        onValueChange={onChange}
        placeholder={t`Search ${name}`}
        value={value}
      />
    </form>
  );
};

/** What the picker shows while it is open: mounted on each opening, so it starts at the places with nothing picked. */
const PickerBody = ({
  onAdd,
  onReconnect,
}: {
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
      <DialogBody>
        <div {...stylex.props(styles.picker)}>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem key="places">
                {spot === null ? (
                  <BreadcrumbPage>{t`Places`}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      onClick={() => {
                        setSearch("");
                        void loadPlaces();
                      }}
                      type="button"
                    >
                      {t`Places`}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {spot === null
                ? null
                : [{ id: null, name: spot.place.name }, ...spot.trail].map(
                    (step, at, all) => (
                      <BreadcrumbItem key={step.id ?? spot.place.id}>
                        {at === all.length - 1 && spot.query === null ? (
                          <BreadcrumbPage>{step.name}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <button
                              onClick={() => {
                                setSearch("");
                                void loadItems({
                                  place: spot.place,
                                  trail: spot.trail.slice(0, at),
                                  query: null,
                                });
                              }}
                              type="button"
                            >
                              {step.name}
                            </button>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
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
          <div {...stylex.props(styles.box)}>
            {shown.state === "loading" ? (
              <div {...stylex.props(styles.centred)}>
                <Spinner aria-label={t`Loading`} />
              </div>
            ) : null}
            {shown.state === "failed" ? (
              <div {...stylex.props(styles.centred)}>
                <Text size="sm" color="muted">
                  {shown.reconnect
                    ? t`This connection needs to be connected again.`
                    : t`I could not open this just now. Try again in a moment.`}
                </Text>
                {shown.reconnect ? (
                  <Button onClick={onReconnect} size="sm" variant="outline">
                    {t`Connect again`}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {empty === null ? null : (
              <div {...stylex.props(styles.centred)}>
                <Text size="sm" color="muted">
                  {empty}
                </Text>
              </div>
            )}
            {shown.state === "places" ? (
              <ItemGroup>
                {shown.places.map((place) => (
                  <OpenRow
                    icon={placeIcons[place.kind]}
                    key={place.id}
                    name={place.name}
                    onOpen={() => {
                      void loadItems({ place, trail: [], query: null });
                    }}
                  />
                ))}
              </ItemGroup>
            ) : null}
            {shown.state === "items" && spot !== null ? (
              <ItemGroup>
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
                  <MoreRow
                    loading={more}
                    onMore={() => {
                      void loadItems(spot, shown.next);
                    }}
                  />
                )}
              </ItemGroup>
            ) : null}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogClose>{t`Cancel`}</DialogClose>
        <DialogClose
          disabled={count === 0}
          onClick={() => {
            onAdd([...picked.values()]);
          }}
          variant="default"
        >
          {t`${plural(count, { one: "Add # document", other: "Add # documents" })}`}
        </DialogClose>
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Choose documents`}</DialogTitle>
          <DialogDescription>
            {suite === "microsoft"
              ? t`From SharePoint or OneDrive. I read only the files you add.`
              : t`From Google Drive. I read only the files you add.`}
          </DialogDescription>
        </DialogHeader>
        {open ? <PickerBody onAdd={onAdd} onReconnect={onReconnect} /> : null}
      </DialogContent>
    </Dialog>
  );
};
