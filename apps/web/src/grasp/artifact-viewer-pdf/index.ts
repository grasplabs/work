// The Artifact viewer's PDF renderer, on PDF.js, as its own item so pdfjs-dist stays out of the
// core. Import it once (`import "@/components/grasp/artifact-viewer-pdf"`).
import { registerRenderer } from "../artifact-viewer/load-renderer";

registerRenderer("pdf", async () => await import("./pdf"));
