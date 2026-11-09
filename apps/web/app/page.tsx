import { TopBar } from "@/components/top-bar";
import { Stage } from "@/components/stage";
import { ReelBar } from "@/components/reel-bar";
import { demo } from "@/lib/demo";

export default function Page() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <TopBar project={demo} />
      <Stage project={demo} />
      <ReelBar project={demo} />
    </div>
  );
}
