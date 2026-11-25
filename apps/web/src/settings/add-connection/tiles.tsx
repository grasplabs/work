import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupAddon,
} from "@grasp-os/ui/components/input-group";
import { Item } from "@grasp-os/ui/components/item";
import { ChevronRightIcon, Icon, SearchIcon } from "@grasp-os/ui/lib/icons";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
// The first view of Add connection: the search field, then each group's heading over its tiles,
// two to a row (one on a phone), and a quiet line when nothing matches. The arrow keys move through
// the tiles as the grid stands, across groups; Tab reaches each tile too.
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef } from "react";

import type { AddConnectionGroup, AddConnectionProvider } from "./model.ts";
import { ProviderMark, ProviderWords } from "./parts.tsx";
import type { AddConnectionWords } from "./words.ts";

/** A tile: the one button in its box. */
export const TILE = "button[data-slot=item]";

const styles = stylex.create({
  // Under the sheet's head, on the body's inset, standing still while the tiles scroll.
  search: {
    flexShrink: 0,
    paddingInline: space["6"],
    marginBlockStart: space["5"],
  },
  // Its own width decides the columns: a sheet on a phone, or a narrow frame, has one.
  groups: {
    display: "grid",
    rowGap: space["6"],
    paddingBlockEnd: space["2"],
    containerType: "inline-size",
  },
  group: { display: "grid", rowGap: space["3"], minWidth: 0 },
  heading: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  // Two equal columns, every tile in a row as tall as the other; one column under 28rem (a phone).
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@container (max-width: 28rem)": "minmax(0, 1fr)",
    },
    gap: space["3"],
  },
  tile: { display: "grid", minWidth: 0 },
  // A quiet "Add another" at the end of the name's line, in the smaller label size: the tile keeps
  // its two lines, and the host its whole width.
  addAnother: {
    flexShrink: 0,
    fontSize: font.textXs,
    // The name's own line height, so the line, and the tile, stand no taller for it.
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
  },
  chevron: { display: "flex", flexShrink: 0, color: colors.mutedForeground },
  empty: {
    margin: 0,
    paddingBlock: space["8"],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    textAlign: "center",
  },
});

/** The groups with only the providers whose name or host holds the search, and none left empty. */
export const matching = (
  groups: readonly AddConnectionGroup[],
  query: string
): AddConnectionGroup[] => {
  const words = query.trim().toLocaleLowerCase();
  if (words === "") {
    return [...groups];
  }
  return groups
    .map((group) => ({
      ...group,
      providers: group.providers.filter(
        (provider) =>
          provider.name.toLocaleLowerCase().includes(words) ||
          provider.host.toLocaleLowerCase().includes(words)
      ),
    }))
    .filter((group) => group.providers.length > 0);
};

/** Where a tile stands on the screen: its row's top and its centre. */
const placeOf = (tile: HTMLElement) => {
  const box = tile.getBoundingClientRect();
  return { top: box.top, centre: box.left + box.width / 2 };
};

/** The tile in the next row up or down, the nearest to this one's centre. */
const across = (
  tiles: readonly HTMLElement[],
  from: HTMLElement,
  down: boolean
) => {
  const at = placeOf(from);
  const rows = tiles
    .map((tile) => ({ tile, ...placeOf(tile) }))
    .filter((each) => (down ? each.top > at.top + 1 : each.top < at.top - 1));
  // The nearest row that way; with none, nothing matches it.
  const edge = down
    ? Math.min(...rows.map((each) => each.top))
    : Math.max(...rows.map((each) => each.top));
  return rows
    .filter((each) => Math.abs(each.top - edge) < 1)
    .toSorted(
      (a, b) => Math.abs(a.centre - at.centre) - Math.abs(b.centre - at.centre)
    )[0]?.tile;
};

/** The tile a key moves to from `from`, as the grid stands; none for any other key. */
const targetOf = (
  key: string,
  tiles: readonly HTMLElement[],
  from: HTMLElement,
  rtl: boolean
) => {
  const index = tiles.indexOf(from);
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  const moves: Record<string, () => HTMLElement | undefined> = {
    [forward]: () => tiles[index + 1],
    [backward]: () => tiles[index - 1],
    ArrowDown: () => across(tiles, from, true),
    ArrowUp: () => across(tiles, from, false),
    Home: () => tiles[0],
    End: () => tiles.at(-1),
  };
  return Object.hasOwn(moves, key) ? moves[key]?.() : undefined;
};

/** Moves the focus between tiles by the arrow keys, Home and End. */
const moveFocus = (box: HTMLElement) => (event: KeyboardEvent) => {
  const at = event.target;
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(at instanceof HTMLElement) ||
    !at.matches(TILE)
  ) {
    return;
  }
  const tiles = [...box.querySelectorAll<HTMLElement>(TILE)];
  const next = targetOf(
    event.key,
    tiles,
    at,
    getComputedStyle(box).direction === "rtl"
  );
  if (next !== undefined) {
    event.preventDefault();
    next.focus();
  }
};

/** The search field, standing between the sheet's head and its body. */
export const ConnectionSearch = ({
  query,
  onQueryChange,
  words,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  words: AddConnectionWords;
}) => (
  <div {...stylex.props(styles.search)}>
    <InputGroup>
      <InputGroupAddon>
        <Icon icon={SearchIcon} />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        aria-label={words.search}
        placeholder={words.search}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onValueChange={(value: string) => {
          onQueryChange(value);
        }}
      />
      {query !== "" && <InputGroupClear aria-label={words.clearSearch} />}
    </InputGroup>
  </div>
);

/** A provider's tile: one button, its mark, name and host, and its end. */
const Tile = ({
  provider,
  onChoose,
  words,
}: {
  provider: AddConnectionProvider;
  onChoose: (provider: AddConnectionProvider) => void;
  words: AddConnectionWords;
}) => (
  <div data-provider={provider.id} {...stylex.props(styles.tile)}>
    <Item
      variant="outline"
      size="sm"
      onClick={() => {
        onChoose(provider);
      }}
    >
      <ProviderMark provider={provider} />
      <ProviderWords
        provider={provider}
        said={provider.connected === true ? words.connected : undefined}
        end={
          provider.connected === true && (
            <span aria-hidden="true" {...stylex.props(styles.addAnother)}>
              {words.addAnother}
            </span>
          )
        }
      />
      {provider.connected !== true && (provider.opens ?? "key") === "key" && (
        <span {...stylex.props(styles.chevron)}>
          <Icon icon={ChevronRightIcon} />
        </span>
      )}
    </Item>
  </div>
);

/** The groups of tiles, as the search leaves them, or the line that says nothing matches. */
export const ConnectionTiles = ({
  groups,
  query,
  onChoose,
  words,
}: {
  groups: readonly AddConnectionGroup[];
  query: string;
  onChoose: (provider: AddConnectionProvider) => void;
  words: AddConnectionWords;
}) => {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return () => {
        // Nothing was listened for, so nothing stops.
      };
    }
    const press = moveFocus(element);
    element.addEventListener("keydown", press);
    return () => {
      element.removeEventListener("keydown", press);
    };
  }, []);
  const shown = matching(groups, query);
  return (
    <div
      ref={box}
      data-slot="add-connection-tiles"
      {...stylex.props(styles.groups)}
    >
      {shown.map((group) => (
        <section
          key={group.id}
          aria-labelledby={`${id}-${group.id}`}
          {...stylex.props(styles.group)}
        >
          <h3 id={`${id}-${group.id}`} {...stylex.props(styles.heading)}>
            {group.label}
          </h3>
          <div {...stylex.props(styles.grid)}>
            {group.providers.map((provider) => (
              <Tile
                key={provider.id}
                provider={provider}
                onChoose={onChoose}
                words={words}
              />
            ))}
          </div>
        </section>
      ))}
      <div aria-live="polite">
        {shown.length === 0 && (
          <p {...stylex.props(styles.empty)}>{words.noResults(query.trim())}</p>
        )}
      </div>
    </div>
  );
};
