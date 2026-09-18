import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./ui/Root.js";
import { loadViewerConfig } from "./config.js";
import "./styles/base.css";
import "./styles/landing.css";
import "./styles.css";

void loadViewerConfig().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
});
