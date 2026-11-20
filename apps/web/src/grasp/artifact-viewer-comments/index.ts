// The Artifact viewer's comments, as their own item: the panel, threads on words, cells and boxes,
// and replies. Import it once (`import "@/components/grasp/artifact-viewer-comments"`): then
// `comments`, `onComment`, `onReply`, `onResolve` and `onDelete` work. Its code loads with the
// viewer's lazy shell.
import { registerComments } from "../artifact-viewer/extras";

registerComments(async () => {
  const { useComments } = await import("./use-comments");
  return useComments;
});
