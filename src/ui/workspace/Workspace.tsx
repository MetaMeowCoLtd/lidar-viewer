import { useState } from "react";
import { useWorkspace } from "./use-workspace.js";
import { TopBar } from "./TopBar.js";
import { Viewport } from "./Viewport.js";
import { StatusBar } from "./StatusBar.js";
import { Sidebar } from "./Sidebar.js";
import { QualityReportDialog } from "./QualityReportDialog.js";

/**
 * The workspace: a top bar over one side panel and the scan, and a status line.
 *
 * The side panel is the whole workflow - the scan, one button to analyse it,
 * and each result with its own controls - so there are no tabs to learn. How
 * the scan is drawn lives in the Display menu, what it is coloured by over the
 * scan itself. The panel can be tucked away with the button in the corner, and
 * H hides everything but the scan.
 */
export function Workspace({ sampleOnStart }: { sampleOnStart?: string | undefined }) {
  const workspace = useWorkspace({ sampleOnStart });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Before a scan is open the viewport's own welcome says everything; a panel beside it would repeat it.
  const showSidebar = sidebarOpen && workspace.source !== undefined;

  return (
    <div className={workspace.uiHidden ? "ws is-bare" : "ws"}>
      <TopBar workspace={workspace} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
      <div className={showSidebar ? "ws-body" : "ws-body is-collapsed"}>
        {showSidebar ? <Sidebar workspace={workspace} /> : null}
        <Viewport workspace={workspace} />
      </div>
      <StatusBar workspace={workspace} />
      <QualityReportDialog workspace={workspace} />
    </div>
  );
}
