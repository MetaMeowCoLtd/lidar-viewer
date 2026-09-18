import { Landing } from "./landing/Landing.js";
import { Workspace } from "./workspace/Workspace.js";
import { useRoute } from "./router.js";

export function Root() {
  const route = useRoute();
  return route.page === "app" ? <Workspace loadSampleOnStart={route.sample} /> : <Landing />;
}
