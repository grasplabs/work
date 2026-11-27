// The demo of the direction provider, for the kit's accessibility checks
// (test/kit.browser.test.tsx).
import { Button } from "@grasp-os/app-kit/components/button";
import { DirectionProvider } from "@grasp-os/app-kit/components/direction";

const DirectionDemo = () => (
  <DirectionProvider direction="rtl">
    <div className="flex flex-wrap gap-2" dir="rtl" lang="ar">
      <Button>حفظ</Button>
      <Button variant="outline">إلغاء</Button>
    </div>
  </DirectionProvider>
);

export const directionDemos = {
  direction: DirectionDemo,
};
