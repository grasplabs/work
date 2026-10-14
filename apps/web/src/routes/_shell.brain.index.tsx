import { createFileRoute } from "@tanstack/react-router";

import { useBrainData } from "../brain/brain-data.ts";
import { HomePage } from "../brain/brain-home.tsx";

// The brain's own address. In the prototype it is the atlas, the brain to
// explore (`routes/brain/index.tsx`); the atlas comes in a later change, so
// for now it shows the brain's home (`components/brain-home.tsx`), as the
// company's note does.

const BrainIndex = () => {
  const { brain } = useBrainData();
  return <HomePage brain={brain} />;
};

export const Route = createFileRoute("/_shell/brain/")({
  component: BrainIndex,
});
