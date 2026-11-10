import { TopBar } from "@/components/top-bar";
import { Stage } from "@/components/stage";
import { ReelBar } from "@/components/reel-bar";
import { toStageView } from "@/lib/read-model";
import { sampleProject } from "@/lib/sample-project";

const view = toStageView(sampleProject, { currentShotId: "s-04" });

export default function Page() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar view={view} />
      <Stage view={view} />
      <ReelBar view={view} />
    </div>
  );
}
