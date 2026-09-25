import { Icon } from "../icons.js";
import { Menu, MenuItem } from "../controls.js";
import { formatCount } from "../format.js";
import { landingHref } from "../router.js";
import type { Workspace } from "./use-workspace.js";
import { DisplayMenu } from "./DisplayMenu.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { SampleAbout } from "./SampleAbout.js";

/** The scan on screen, the things done to a whole scan - opening and exporting it - and how it is drawn. */
export function TopBar({ workspace, sidebarOpen, onToggleSidebar }: { workspace: Workspace; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const { source, sourceLabel, exports, analysis, view } = workspace;
  const crs = source?.spatialReference?.epsg;

  return (
    <header className="ws-top">
      <button type="button" className="icon-btn" aria-pressed={sidebarOpen} title={sidebarOpen ? "Hide the side panel" : "Show the side panel"} onClick={onToggleSidebar}>
        <Icon name="sidebar" />
      </button>
      <a className="logo" href={landingHref} title="Back to the home page">
        <Icon name="logo" className="logo-mark" />
        <span className="ws-top-name">Vertex LiDAR</span>
      </a>

      {source === undefined ? null : (
        <div className="ws-file" title={sourceLabel}>
          <Icon name="file" />
          <strong>{sourceLabel}</strong>
          <span>{formatCount(source.pointCount)} points</span>
          <span>{`${Math.round(source.bounds.size[0])} × ${Math.round(source.bounds.size[2])} m`}</span>
          <span>{crs === undefined ? (source.isGeoreferenced ? "World coordinates" : "Local coordinates") : `EPSG:${crs}`}</span>
        </div>
      )}
      {source === undefined || workspace.shownSample === undefined ? null : (
        <Menu label="About" icon="info" align="start" wide>
          {() => <SampleAbout sample={workspace.shownSample!} />}
        </Menu>
      )}

      <div className="ws-top-actions">
        <Menu label="Samples" icon="city">
          {(close) => (
            <>
              <p className="menu-title">Real drone surveys</p>
              {workspace.samples.map((sample) => (
                <MenuItem
                  key={sample.id}
                  label={sample.name}
                  hint={sample.summary}
                  onClick={() => {
                    close();
                    void workspace.actions.loadSample(sample);
                  }}
                />
              ))}
            </>
          )}
        </Menu>
        <button type="button" className="btn" onClick={workspace.actions.openFilePicker}>
          <Icon name="folder" /> Open scan
        </button>
        <Menu label="Export" icon="download" disabled={source === undefined}>
          {(close) => {
            const run = (kind: Parameters<typeof exports.exportScan>[0]) => () => {
              close();
              void exports.exportScan(kind);
            };
            const classified = view.supports.classification;
            const counted = exports.counted;
            const terrainReady = analysis.terrain.status === "done";
            return (
              <>
                <p className="menu-title">Points</p>
                <MenuItem
                  label="Classified points"
                  hint={classified ? "LAS 1.4 with heights and object ids" : "Detect ground or count first"}
                  disabled={exports.exportBlocked || !classified}
                  busy={exports.exporting === "las"}
                  onClick={run("las")}
                />
                <MenuItem
                  label="Cleaned points"
                  hint={view.noisePoints > 0 ? "LAS with the noise left out" : "Find noise first"}
                  disabled={exports.exportBlocked || view.noisePoints === 0}
                  busy={exports.exporting === "cleaned"}
                  onClick={run("cleaned")}
                />
                <MenuItem
                  label="Class summary"
                  hint={classified ? "CSV of points per class" : "Detect ground or count first"}
                  disabled={exports.exportBlocked || !classified}
                  busy={exports.exporting === "classes"}
                  onClick={run("classes")}
                />
                <p className="menu-title">Buildings and trees</p>
                <MenuItem
                  label="Inventory"
                  hint={counted ? "CSV, one row per object" : "Count buildings and trees first"}
                  disabled={exports.exportBlocked || !counted}
                  busy={exports.exporting === "inventory"}
                  onClick={run("inventory")}
                />
                <MenuItem
                  label="Map layer"
                  hint={counted ? "GeoJSON footprints and treetops" : "Count buildings and trees first"}
                  disabled={exports.exportBlocked || !counted}
                  busy={exports.exporting === "geojson"}
                  onClick={run("geojson")}
                />
                <p className="menu-title">Terrain</p>
                <MenuItem
                  label="Elevation model"
                  hint={terrainReady ? "GeoTIFF, one elevation per cell" : "Build the terrain first"}
                  disabled={exports.exportBlocked || !terrainReady}
                  busy={exports.exporting === "elevation"}
                  onClick={run("elevation")}
                />
                <MenuItem
                  label="Contour lines"
                  hint={terrainReady ? "GeoJSON lines with elevations" : "Build the terrain first"}
                  disabled={exports.exportBlocked || !terrainReady}
                  busy={exports.exporting === "contours"}
                  onClick={run("contours")}
                />
                <p className="menu-footnote">
                  Written on this device, in the scan's own coordinate system. LAS output is uncompressed.
                </p>
              </>
            );
          }}
        </Menu>
        <DisplayMenu workspace={workspace} />
        <ThemeToggle />
      </div>
    </header>
  );
}
