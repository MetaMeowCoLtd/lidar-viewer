import { useState } from "react";
import { Icon, type IconName } from "../icons.js";
import { useWorkspace, type Workspace as WorkspaceState } from "./use-workspace.js";
import { TopBar } from "./TopBar.js";
import { Viewport } from "./Viewport.js";
import { StatusBar } from "./StatusBar.js";
import { ScanPanel } from "./panels/ScanPanel.js";
import { ViewPanel } from "./panels/ViewPanel.js";
import { AnalyzePanel } from "./panels/AnalyzePanel.js";
import { SettingsPanel } from "./panels/SettingsPanel.js";

type PanelId = "scan" | "view" | "analyze" | "settings";

const tabs: readonly { id: PanelId; icon: IconName; label: string }[] = [
  { id: "scan", icon: "file", label: "Scan" },
  { id: "view", icon: "eye", label: "View" },
  { id: "analyze", icon: "sparkles", label: "Analyze" },
  { id: "settings", icon: "sliders", label: "Settings" },
];

/**
 * The workspace: a top bar over a tool rail, one open panel, the scan itself,
 * and a status line.
 *
 * Only one panel is open at a time, which is what keeps the controls from
 * becoming the single long scroll they were before; the rail says what else is
 * there. Clicking the open tab closes it and gives the whole window to the
 * scan, as does pressing H.
 */
export function Workspace({ loadSampleOnStart }: { loadSampleOnStart: boolean }) {
  const workspace = useWorkspace({ loadSampleOnStart });
  const [panel, setPanel] = useState<PanelId | undefined>("scan");

  return (
    <div className={workspace.uiHidden ? "ws is-bare" : "ws"}>
      <TopBar workspace={workspace} />
      <div className="ws-body">
        <nav className="ws-rail" aria-label="Panels">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={panel === tab.id ? "ws-rail-tab is-active" : "ws-rail-tab"}
              aria-pressed={panel === tab.id}
              title={tab.label}
              onClick={() => setPanel((open) => (open === tab.id ? undefined : tab.id))}
            >
              <Icon name={tab.icon} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        {panel === undefined ? null : (
          <aside className="ws-panel" aria-label={`${tabs.find((tab) => tab.id === panel)?.label} panel`}>
            <Panel id={panel} workspace={workspace} />
          </aside>
        )}
        <Viewport workspace={workspace} />
      </div>
      <StatusBar workspace={workspace} />
    </div>
  );
}

function Panel({ id, workspace }: { id: PanelId; workspace: WorkspaceState }) {
  if (id === "scan") return <ScanPanel workspace={workspace} />;
  if (id === "view") return <ViewPanel workspace={workspace} />;
  if (id === "analyze") return <AnalyzePanel workspace={workspace} />;
  return <SettingsPanel workspace={workspace} />;
}
