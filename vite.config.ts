import { defineConfig } from "vite";

// Relative base so the built asset paths (e.g. /assets/index-*.js) resolve
// correctly whether the site is served from the domain root or from a
// GitHub Pages project subpath like https://<org>.github.io/lidar-viewer/.
export default defineConfig({
  base: "./",
});
