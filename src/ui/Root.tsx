import { App } from "../App.js";
import { Landing } from "./landing/Landing.js";
import { useRoute } from "./router.js";

export function Root() {
  const route = useRoute();
  return route.page === "app" ? <App /> : <Landing />;
}
