import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ChatPanels } from "../../chat/chat-panel.tsx";
import { Panels } from "./panels.tsx";

// The page's card with Grasp's chat beside it (app-frame.tsx), as #2503's
// App shell seats its panels: the card and the chat's card side by side on
// the sidebar's ground, the gutter between them the handle that resizes
// the chat; the chat as a window over the page, or over the whole card,
// full screen; on a phone, or where the page would be squeezed under its
// least, the chat over the page. What the shell kept for its panels (the
// phone's rule as the CSS decided it, where focus stood in the page) is
// kept here.

const styles = stylex.create({
  // The room beside the sidebar, the window's height, which the two cards
  // share.
  room: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    height: "100svh",
  },
});

/** How the page's card stands under the chat: covered by it, and whether on a phone. */
export interface CardPlace {
  /** The chat lies over the page: full screen, or for want of room. */
  covered: boolean;
  /** On a phone, where the bar's row stays over the chat and only the page goes under it. */
  phone: boolean;
}

/**
 * Where the chat stands against the page's card: whether it covers the
 * page (full screen, or for want of room) and whether on a phone, as the
 * panels say once they have measured the room.
 */
export const useChatCover = (panels: ChatPanels | undefined) => {
  const [narrow, setNarrow] = useState(false);
  // Whether the page would be squeezed under its least beside the chat
  // (a phone too): the chat then lies over it; undefined until measured.
  const [crowded, setCrowded] = useState<boolean>();
  const shown = panels !== undefined && panels.panels !== null && panels.open;
  const place: CardPlace = {
    covered: panels?.covered === true || (shown && crowded === true),
    phone: shown && narrow,
  };
  return {
    place,
    narrow,
    handleNarrowChange: setNarrow,
    handleCrowdedChange: setCrowded,
  };
};

/** The page's card, and the chat beside it, over it as a window, or over it full screen. */
export const ChatPanelsBeside = ({
  card,
  panels,
  cover,
}: {
  card: ReactNode;
  panels: ChatPanels;
  cover: ReturnType<typeof useChatCover>;
}) => {
  const { t } = useLingui();
  // Where focus stood in the page's card when the chat last covered it.
  const keep = useRef(-1);
  const {
    onWidthChange: handleWidthChange,
    onPositionChange: handlePositionChange,
    onHeightChange: handleHeightChange,
    onPlacementChange: handlePlacementChange,
    onClose: handleClose,
  } = panels;
  return (
    <div {...stylex.props(styles.room)}>
      <Panels
        aside={false}
        card={card}
        closeLabel={t`Close the chat`}
        covered={cover.place.covered}
        keep={keep}
        max={panels.maxWidth}
        min={panels.minWidth}
        narrow={cover.narrow}
        onCrowdedChange={cover.handleCrowdedChange}
        onNarrowChange={cover.handleNarrowChange}
        open={panels.open}
        panels={panels.panels}
        placement={panels.placement}
        resizeLabel={t`Resize the chat`}
        width={panels.width}
        onWidthChange={handleWidthChange}
        {...(handlePlacementChange === undefined
          ? {}
          : { onPlacementChange: handlePlacementChange })}
        {...(panels.position === undefined
          ? {}
          : { position: panels.position })}
        onPositionChange={handlePositionChange}
        {...(panels.height === undefined ? {} : { height: panels.height })}
        onHeightChange={handleHeightChange}
        {...(handleClose === undefined ? {} : { onClose: handleClose })}
      />
    </div>
  );
};
