"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { BrandIcon } from "../brand-icon";
import {
  Agent,
  AppRecord,
  Brain,
  Code,
  File,
  Icon,
  Mic,
  Person,
  Rows,
  Web,
  Workflow,
} from "../icons";
import type { IconData } from "../icons";
import { accessOf, hasWords, isRun, kindOf } from "./source";
import { sourceStyles as styles } from "./styles";
import type { Source, SourceKind } from "./types";

const kindIcons: Record<SourceKind, IconData> = {
  file: File,
  web: Web,
  record: AppRecord,
  message: AppRecord,
  meeting: Mic,
  person: Person,
  agent: Agent,
  workflow: Workflow,
  table: Rows,
  memory: Brain,
  code: Code,
};

/** The icon a source's kind wears, or its own. */
export const iconOf = (source: Source) =>
  source.icon ?? kindIcons[kindOf(source)];

/** A web page's own small icon; its kind's icon if there is none or it will not load. */
const Favicon = ({ source }: { source: Source }) => {
  const [broken, setBroken] = useState(false);
  if (!hasWords(source.favicon) || broken) {
    return <Icon icon={iconOf(source)} />;
  }
  return (
    <img
      src={source.favicon}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      referrerPolicy="no-referrer"
      data-no-zoom=""
      onError={() => {
        setBroken(true);
      }}
      {...stylex.props(styles.favicon)}
    />
  );
};

/** What stands on the tile: a portrait, a brand, a favicon or an icon. */
const Face = ({ source, size }: { source: Source; size: "row" | "pile" }) => {
  const kind = kindOf(source);
  if (kind === "person" && source.person !== undefined) {
    return (
      <Avatar
        name={source.person.name}
        size={size === "row" ? "sm" : "xs"}
        decorative
      >
        <AvatarImage src={source.person.src} />
        <AvatarFallback />
      </Avatar>
    );
  }
  if (source.brand !== undefined && source.icon === undefined) {
    return (
      <BrandIcon
        brand={source.brand}
        tile={false}
        size={size === "row" ? "sm" : "xs"}
        decorative
      />
    );
  }
  if (kind === "web") {
    return <Favicon source={source} />;
  }
  return <Icon icon={iconOf(source)} />;
};

/** A source's mark on its tile: 32px in a row and a card, smaller in the pile. */
export const SourceTile = ({
  source,
  size,
}: {
  source: Source;
  size: "row" | "pile";
}) => {
  const kind = kindOf(source);
  const quiet = accessOf(source) !== "open";
  const portrait = kind === "person" && source.person !== undefined;
  const sender = kind === "message" && size === "row";
  return (
    <span
      aria-hidden="true"
      data-slot="source-tile"
      data-kind={kind}
      {...stylex.props(
        styles.tile,
        size === "row" ? styles.tileRow : styles.tilePile,
        portrait && styles.tileRound,
        isRun(kind) && styles.runTint,
        quiet && styles.tileQuiet
      )}
    >
      <Face source={source} size={size} />
      {sender && hasWords(source.person?.src) ? (
        <span {...stylex.props(styles.sender)}>
          <img
            src={source.person?.src}
            alt=""
            data-no-zoom=""
            {...stylex.props(styles.portrait)}
          />
        </span>
      ) : null}
    </span>
  );
};
