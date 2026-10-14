import type { Gap, Workspace } from "@grasp-os/shared/brain";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { BrainAtlas } from "../brain/atlas-canvas.tsx";
import type { AtlasControls, AtlasView } from "../brain/atlas-canvas.tsx";
import {
  clusterFolder,
  folderHolding,
  MAP_ROOM,
  neuronMap,
  regionGroups,
} from "../brain/atlas-map.ts";
import type { Neuron, RegionGroup } from "../brain/atlas-map.ts";
import {
  AtlasLegend,
  AtlasTrail,
  legendCorner,
} from "../brain/atlas-overlays.tsx";
import type { Spot, TrailStep } from "../brain/atlas-overlays.tsx";
import {
  atlasOf,
  isRegion,
  REGION_IDS,
  REGIONS,
  signalPaths,
} from "../brain/brain-atlas.ts";
import type { Atlas, RegionId } from "../brain/brain-atlas.ts";
import { useBrainData } from "../brain/brain-data.ts";
import type { Brain } from "../brain/brain.ts";
import type { BrainDots } from "../brain/dot-ink.ts";
import { useLessMotion } from "../brain/less-motion.ts";
import { beginNoteReveal } from "../brain/note-reveal.tsx";

// The brain's own address: the brain as an atlas, as in the prototype
// (`routes/brain/index.tsx`). The prototype's chat at its foot, which tells
// a region's story and answers its open questions there, is the app's own
// chat here (chat/chat-dock.tsx), the same on every page: the atlas keeps
// its bar clear, and lights nothing until an answer can name notes.

/** What the brain keeps clear, in pixels: a little along the top and the sides; and the chat's bar along the bottom. The legend's corner, top left, depends on the region's groups. */
const CLEAR = { top: 12, bottom: 64 };

/** Nothing is lit by the chat: the brain fires what it holds. */
const LIT: string[] = [];

/** A value of the address that reads as text. */
const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The view in the address: only what reads as one. */
const validateSearch = (search: Record<string, unknown>): AtlasView => {
  const group = textOf(search.group);
  const note = textOf(search.note);
  return {
    ...(isRegion(search.region) ? { region: search.region } : {}),
    ...(group === undefined ? {} : { group }),
    ...(note === undefined ? {} : { note }),
  };
};

/** A view as the address writes it: only what it has. */
const searchOf = (view: AtlasView): AtlasView => ({
  ...(view.region === undefined ? {} : { region: view.region }),
  ...(view.group === undefined ? {} : { group: view.group }),
  ...(view.note === undefined ? {} : { note: view.note }),
});

/**
 * What the address shows: a note alone in it, as a note's own page sends it, opens its region; a
 * note in hand inside a folded folder, as "Show in the brain" sends it, opens that folder, so it
 * is there to see. With the folders the region can be narrowed to.
 */
const viewOf = (
  search: AtlasView,
  atlas: Atlas,
  brain: Brain
): { view: AtlasView; groups: RegionGroup[] } => {
  const { note } = search;
  const region =
    search.region ?? (note === undefined ? undefined : atlas.home.get(note));
  if (region === undefined) {
    return { view: { note }, groups: [] };
  }
  const groups = regionGroups(region, atlas);
  const holding =
    note !== undefined && search.group === undefined
      ? folderHolding(region, atlas, brain, note)
      : undefined;
  const asked = search.group ?? holding;
  const group = groups.some((each) => each.key === asked) ? asked : undefined;
  return { view: { region, group, note }, groups };
};

/** What is in hand: an open question; or a neuron, one note or a folder of them. */
const inHandOf = (
  ws: Workspace,
  neurons: Neuron[],
  note: string | undefined
): { gap?: Gap; neuron?: Neuron } => {
  if (note === undefined) {
    return {};
  }
  const gap = ws.gaps.find(
    (each) => each.id === note && each.closedAt === undefined
  );
  if (gap) {
    return { gap };
  }
  return {
    neuron: neurons.find(
      (each) => each.id === note || each.noteIds.includes(note)
    ),
  };
};

/** The way here from the whole brain: the region, the folder it is narrowed to, and what is in hand, each with its view. */
const trailOf = (
  view: AtlasView,
  labels: { brain: string; region?: string; group?: string; inHand?: string }
): TrailStep[] => {
  const { region, group, note } = view;
  if (region === undefined) {
    return [];
  }
  const steps: TrailStep[] = [{ label: labels.brain, view: {} }];
  if (labels.region !== undefined) {
    steps.push({ label: labels.region, view: { region } });
  }
  if (labels.group !== undefined) {
    steps.push({ label: labels.group, view: { region, group } });
  }
  if (labels.inHand !== undefined) {
    steps.push({ label: labels.inHand, view: { region, group, note } });
  }
  return steps;
};

/** Where the keys go from a note in a region: the next or the one before, round and round. */
const nextNeuron = (
  neurons: Neuron[],
  current: string | undefined,
  forward: boolean
): Neuron | undefined => {
  const at = neurons.findIndex((each) => each.id === current);
  if (at === -1) {
    return forward ? neurons[0] : neurons.at(-1);
  }
  return neurons[(at + (forward ? 1 : -1) + neurons.length) % neurons.length];
};

/** One step out: from a note to its region or folder, from a folder to its region, from a region to the whole brain. */
const stepOut = (view: AtlasView): AtlasView | undefined => {
  if (view.note !== undefined) {
    return { region: view.region, group: view.group };
  }
  if (view.group !== undefined) {
    return { region: view.region };
  }
  return view.region === undefined ? undefined : {};
};

/** Whether a key was meant for what is typed in, or for the browser. */
/** Whether two layouts of a region hold the same neurons, in the same order. */
const sameNeurons = (one: Neuron[], other: Neuron[]): boolean =>
  one.length === other.length &&
  one.every((neuron, index) => neuron.id === other[index]?.id);

const keyIsElsewhere = (event: KeyboardEvent): boolean => {
  const typing =
    event.target instanceof Element &&
    event.target.closest('input, textarea, [contenteditable="true"]') !== null;
  return typing || event.metaKey || event.ctrlKey || event.altKey;
};

/** Enter on a button or a link is that one's own. */
const keyOnControl = (event: KeyboardEvent): boolean =>
  event.target instanceof Element && event.target.closest("button, a") !== null;

/**
 * The brain as an atlas, with the whole canvas to itself: the whole brain, a region up close, or
 * one note in it, kept in the address so back and forward step through where you have been. In
 * its corners sit what a dot says and the zoom. A note opens its own page, full screen: the camera
 * goes in on its neuron, whose dots then build the page. The keys: arrows move between regions or
 * notes, Enter goes into a region or opens the note, Escape steps out.
 */
const AtlasPage = () => {
  const { t, i18n } = useLingui();
  const { workspace: ws, brain } = useBrainData();
  const atlas = atlasOf(ws, brain);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/brain/" });
  const reduce = useLessMotion();
  const { view, groups } = viewOf(search, atlas, brain);
  const { region, group } = view;
  // The region's neurons, for the keys: as the atlas lays them out in the room it has, where a folder may be folded into one; until it has, as a roomy screen would show them.
  const [laid, setLaid] = useState<{
    region?: RegionId;
    group?: string;
    neurons: Neuron[];
  }>({ neurons: [] });
  const roomy =
    region === undefined
      ? []
      : neuronMap(region, atlas, brain, MAP_ROOM, group).neurons;
  const neurons =
    region !== undefined && laid.region === region && laid.group === group
      ? laid.neurons
      : roomy;
  const signals = signalPaths(ws, atlas);
  const controls = useRef<AtlasControls>(null);
  // The keys' place on the whole brain, before it is entered.
  const [cursor, setCursor] = useState(-1);
  const pointed = region === undefined ? REGION_IDS[cursor] : undefined;
  // The note the camera is going in on, on its way to its page. Leaving the view it began in
  // (a crumb, a group, the browser's back) ends it: the note may not be on the next one.
  const [dive, setDive] = useState<string>();
  const viewKey = JSON.stringify(searchOf(view));
  const [diveView, setDiveView] = useState(viewKey);
  if (viewKey !== diveView) {
    setDiveView(viewKey);
    setDive(undefined);
  }
  // The mark of the legend the pointer is on: its dots light up.
  const [spot, setSpot] = useState<Spot>();
  const { gap, neuron } = inHandOf(ws, neurons, view.note);

  const regionLabel = REGIONS.find((each) => each.id === region)?.label;
  const trail = trailOf(view, {
    brain: t`Brain`,
    region: regionLabel === undefined ? undefined : i18n._(regionLabel),
    group: groups.find((each) => each.key === group)?.label,
    inHand: gap?.question ?? neuron?.title ?? neuron?.label,
  });

  const go = (next: AtlasView) => {
    setCursor(-1);
    void navigate({ search: searchOf(next) });
  };
  // A note's own page. From its neuron, the camera goes in first and its dots build the page.
  const open = (noteId: string) => {
    const onMap = neurons.some(
      (each) => each.kind !== "cluster" && each.noteIds[0] === noteId
    );
    if (onMap && !reduce) {
      setDive(noteId);
    } else {
      void navigate({ to: "/brain/$noteId", params: { noteId } });
    }
  };
  const dived = (dots: BrainDots) => {
    if (dive === undefined) {
      return;
    }
    beginNoteReveal(dots);
    void navigate({ to: "/brain/$noteId", params: { noteId: dive } });
  };

  // Enter goes into what the keys chose: a region, a folder, a note.
  const enter = () => {
    const chosen = REGION_IDS[cursor];
    const [noteId] = neuron?.noteIds ?? [];
    if (region === undefined && chosen !== undefined) {
      go({ region: chosen });
    } else if (neuron?.kind === "cluster") {
      go({ region, group: clusterFolder(neuron.id) });
    } else if (noteId !== undefined) {
      open(noteId);
    }
  };

  const arrow = (forward: boolean) => {
    if (region === undefined) {
      setCursor(
        (cursor + (forward ? 1 : -1) + REGION_IDS.length) % REGION_IDS.length
      );
      return;
    }
    const next = nextNeuron(neurons, view.note, forward);
    if (next) {
      go({ region, group, note: next.id });
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (keyIsElsewhere(event) || dive !== undefined) {
      return;
    }
    const out = stepOut(view);
    if (event.key === "Escape" && out) {
      go(out);
    } else if (event.key === "Enter" && !keyOnControl(event)) {
      enter();
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      arrow(true);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      arrow(false);
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  });

  return (
    <BrainAtlas
      atlas={atlas}
      brain={brain}
      clear={{ ...CLEAR, corner: legendCorner(groups.length), right: 0 }}
      controls={controls}
      dive={dive}
      lit={LIT}
      onDived={dived}
      onGo={go}
      onLaid={(shown) => {
        setLaid((before) =>
          before.region === region &&
          before.group === group &&
          sameNeurons(before.neurons, shown)
            ? before
            : { region, group, neurons: shown }
        );
      }}
      onOpen={open}
      pointed={pointed}
      signals={signals}
      spot={spot}
      view={view}
    >
      <AtlasLegend
        groups={
          groups.length > 0
            ? {
                items: groups,
                total: groups.reduce((sum, each) => sum + each.count, 0),
                selected: group,
                onSelect: (key) => {
                  go({ region, group: key });
                },
              }
            : undefined
        }
        onReset={() => controls.current?.reset()}
        onSpot={setSpot}
        onZoom={(factor) => controls.current?.zoom(factor)}
        spot={spot}
        under={region !== undefined}
      />
      {dive === undefined ? <AtlasTrail onGo={go} steps={trail} /> : null}
    </BrainAtlas>
  );
};

export const Route = createFileRoute("/_shell/brain/")({
  validateSearch,
  component: AtlasPage,
});
