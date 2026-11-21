import { useLook } from "../chat/backdrop-look.ts";
import { LookPictureStage, useLookPicturesAhead } from "./look-picture.tsx";
import { tileLooks } from "./look-tiles.tsx";

/**
 * The stage that draws the Appearance tiles' pictures, mounted by the shell,
 * and, once the shell says the app has loaded (`ahead`), the person's tiles
 * drawn before they open Appearance: drawn there and then, the tiles took
 * seconds to fill.
 */
export const LookPicturesWarm = ({
  userId,
  ahead,
}: {
  userId: string;
  ahead: boolean;
}) => {
  const look = useLook(userId);
  useLookPicturesAhead(ahead ? tileLooks(look) : []);
  return <LookPictureStage />;
};
