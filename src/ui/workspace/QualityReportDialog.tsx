import { useEffect, useMemo } from "react";
import { Icon } from "../icons.js";
import { qualityLevels } from "../../core/quality-report.js";
import { densityHeatmapUrl } from "../../export/quality-report-html.js";
import type { Workspace } from "./use-workspace.js";

const cm = (metres: number) => `${(metres * 100).toFixed(1)} cm`;
const percent = (share: number) => `${(share * 100).toFixed(share < 0.01 ? 2 : 1)} %`;

/** The quality report over the workspace: the density heatmap and every figure, with a download. */
export function QualityReportDialog({ workspace }: { workspace: Workspace }) {
  const { quality, source } = workspace;
  const report = quality.state.status === "done" ? quality.state.report : undefined;
  const heatmap = useMemo(() => (report === undefined ? undefined : densityHeatmapUrl(report, 560)), [report]);

  useEffect(() => {
    if (!quality.reportOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") quality.setReportOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quality]);

  if (!quality.reportOpen || report === undefined || source === undefined) return null;
  const { density, coverage, strips, noise, accuracy } = report;
  const epsg = source.spatialReference?.epsg;

  return (
    <div className="dialog-scrim" role="presentation" onClick={() => quality.setReportOpen(false)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Survey quality report" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <h2>Survey quality report</h2>
            <p>{`${source.name} · ${epsg === undefined ? "local coordinates" : `EPSG:${epsg}`} · ${report.pointCount.toLocaleString("en-US")} points`}</p>
          </div>
          <span className="quality-grade">{report.qualityLevel ?? "Below QL3"}</span>
          <button type="button" className="icon-btn" title="Close" onClick={() => quality.setReportOpen(false)}>
            <Icon name="close" />
          </button>
        </header>

        <div className="dialog-body">
          <section className="report-grid">
            <figure>
              {heatmap === undefined ? null : <img src={heatmap} alt="Point density heatmap, north up" />}
              <figcaption className="report-legend">
                <span><i style={{ background: "#d63031" }} />No returns</span>
                <span><i style={{ background: "#e86e2c" }} />&lt; 2 /m²</span>
                <span><i style={{ background: "#e8b034" }} />2–8 /m²</span>
                <span><i style={{ background: "#3c9a5c" }} />≥ 8 /m²</span>
              </figcaption>
            </figure>
            <div className="report-figures">
              <h3>Density</h3>
              <dl className="stat-list">
                <div><dt>{density.firstReturnsOnly ? "Median, first returns" : "Median, all points"}</dt><dd>{`${density.median.toFixed(1)} /m²`}</dd></div>
                <div><dt>95 % of the area reaches</dt><dd>{`${density.p5.toFixed(1)} /m²`}</dd></div>
                <div><dt>Below 8 /m² (QL1)</dt><dd>{percent(density.belowEight)}</dd></div>
                <div><dt>Below 2 /m² (QL2)</dt><dd>{percent(density.belowTwo)}</dd></div>
              </dl>
              <h3>Coverage</h3>
              <dl className="stat-list">
                <div><dt>Footprint</dt><dd>{`${Math.round(coverage.footprintArea).toLocaleString("en-US")} m²`}</dd></div>
                <div><dt>No returns</dt><dd>{`${percent(coverage.gapShare)} · ${coverage.gapRegions} patches`}</dd></div>
                <div><dt>Largest patch</dt><dd>{`${Math.round(coverage.largestGapArea)} m²`}</dd></div>
              </dl>
              <h3>Noise</h3>
              <p className="note">{noise.labelled ? `${noise.points.toLocaleString("en-US")} points (${percent(noise.share)}) labelled as noise and left out of these figures.` : "Noise has not been found yet."}</p>
            </div>
          </section>

          <section>
            <h3>Strip alignment</h3>
            {strips === undefined ? (
              <p className="note">The scan does not record its flight lines (LAS point source IDs), so strips cannot be compared.</p>
            ) : strips.pairs.length === 0 ? (
              <p className="note">{strips.strips.length < 2 ? "Only one flight line in the scan." : "The strips do not overlap on enough flat ground to compare."}</p>
            ) : (
              <>
                <p className="note">{`${strips.strips.length} flight lines, ${percent(strips.overlapShare)} of the footprint seen twice. Compared on flat ground both saw; over about 5 cm points to a boresight or trajectory error.`}</p>
                <table className="report-table">
                  <thead><tr><th>Strips</th><th>Flat cells</th><th>Median offset</th><th>RMS offset</th></tr></thead>
                  <tbody>
                    {strips.pairs.map((pair) => (
                      <tr key={`${pair.a}-${pair.b}`}><td>{`${pair.a} → ${pair.b}`}</td><td>{pair.cells.toLocaleString("en-US")}</td><td>{cm(pair.medianOffset)}</td><td>{cm(pair.rmsOffset)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section>
            <h3>Vertical accuracy</h3>
            {accuracy === undefined ? (
              <p className="note">Add surveyed checkpoints as a CSV of name, easting, northing, elevation to measure it.</p>
            ) : (
              <>
                <p className="note">{`RMSEz ${cm(accuracy.rmsez)}; ${cm(accuracy.nva95)} at 95 % confidence (1.96 × RMSEz) over ${accuracy.measured} of ${accuracy.checkpoints.length} checkpoints, against ${accuracy.fromGround ? "ground-classified points" : "the lowest points (run ground detection for a better surface)"}.`}</p>
                <table className="report-table">
                  <thead><tr><th>Checkpoint</th><th>Elevation</th><th>Scan − checkpoint</th></tr></thead>
                  <tbody>
                    {accuracy.checkpoints.map((point) => (
                      <tr key={point.name}><td>{point.name}</td><td>{point.elevation.toFixed(3)}</td><td>{point.residual === undefined ? "no ground nearby" : cm(point.residual)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <p className="note">{`Graded against the USGS Lidar Base Specification: ${qualityLevels.map((level) => `${level.name} ≥ ${level.density} /m², RMSEz ≤ ${cm(level.rmsez)}`).join("; ")}.`}</p>
        </div>

        <footer className="dialog-foot">
          <button type="button" className="btn btn-primary" onClick={quality.downloadReport}>
            <Icon name="download" /> Download report (HTML)
          </button>
        </footer>
      </div>
    </div>
  );
}
