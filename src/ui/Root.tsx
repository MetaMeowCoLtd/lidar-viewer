import { Landing } from "./landing/Landing.js";
import { Workspace } from "./workspace/Workspace.js";
import { Benchmark } from "./benchmark/Benchmark.js";
import { useRoute } from "./router.js";

export function Root() {
  const route = useRoute();
  if (route.page === "app") return <Workspace sampleOnStart={route.sample} />;
  if (route.page === "benchmark") return <Benchmark />;
  return <Landing />;
}
