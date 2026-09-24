import { qualityLevels, type QualityReport } from "../core/quality-report.js";

/** Colour of a density cell: gaps red, thin coverage amber, then green brightening with density. */
export function densityColour(density: number, median: number): readonly [number, number, number] {
  if (Number.isNaN(density)) return [0, 0, 0];
  if (density === 0) return [214, 48, 49];
  if (density < 2) return [232, 110, 44];
  if (density < 8) return [232, 176, 52];
  const t = Math.min(1, density / Math.max(8, median * 2));
  return [Math.round(40 + 60 * t), Math.round(120 + 100 * t), Math.round(70 + 40 * t)];
}

/** The density grid as a PNG, north up, one pixel per cell scaled to about `width` pixels across. */
export function densityHeatmapUrl(report: QualityReport, width = 640): string {
  const { cols, rows, grid } = report.density;
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(cols, rows);
  for (let cell = 0; cell < cols * rows; cell += 1) {
    const value = grid[cell]!;
    const [r, g, b] = densityColour(value, report.density.median);
    image.data[cell * 4] = r;
    image.data[cell * 4 + 1] = g;
    image.data[cell * 4 + 2] = b;
    image.data[cell * 4 + 3] = Number.isNaN(value) ? 0 : 255;
  }
  context.putImageData(image, 0, 0);
  const scale = Math.max(1, Math.round(width / cols));
  const scaled = document.createElement("canvas");
  scaled.width = cols * scale;
  scaled.height = rows * scale;
  const target = scaled.getContext("2d")!;
  target.imageSmoothingEnabled = false;
  target.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled.toDataURL("image/png");
}

const escape = (text: string) => text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
const cm = (metres: number) => `${(metres * 100).toFixed(1)} cm`;
const percent = (share: number) => `${(share * 100).toFixed(share < 0.01 ? 2 : 1)} %`;

/**
 * The report as one self-contained HTML file - styles and the heatmap inline -
 * that a client can open anywhere and print to PDF.
 */
export function qualityReportHtml(report: QualityReport, details: { name: string; crs: string; heatmapUrl: string; createdAt?: Date }): string {
  const { density, coverage, strips, noise, accuracy } = report;
  const created = (details.createdAt ?? new Date()).toISOString().slice(0, 10);
  const level = report.qualityLevel ?? "Below QL3";
  const rows = (entries: ReadonlyArray<readonly [string, string]>) => entries.map(([label, value]) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`).join("");
  const stripRows =
    strips === undefined
      ? `<p>The scan does not record flight lines (LAS point source IDs), so strips cannot be compared.</p>`
      : strips.pairs.length === 0
        ? `<p>${strips.strips.length < 2 ? "Only one flight line in the scan." : "The strips do not overlap on enough flat ground to compare."}</p>`
        : `<table><thead><tr><th>Strips</th><th>Flat cells compared</th><th>Median offset</th><th>RMS offset</th></tr></thead><tbody>${strips.pairs
            .map((pair) => `<tr><td>${pair.a} → ${pair.b}</td><td>${pair.cells.toLocaleString("en-US")}</td><td>${cm(pair.medianOffset)}</td><td>${cm(pair.rmsOffset)}</td></tr>`)
            .join("")}</tbody></table>`;
  const checkpointRows =
    accuracy === undefined
      ? `<p>No checkpoints were supplied.</p>`
      : `<table><thead><tr><th>Checkpoint</th><th>Easting</th><th>Northing</th><th>Elevation</th><th>Scan − checkpoint</th></tr></thead><tbody>${accuracy.checkpoints
          .map(
            (point) =>
              `<tr><td>${escape(point.name)}</td><td>${point.east.toFixed(3)}</td><td>${point.north.toFixed(3)}</td><td>${point.elevation.toFixed(3)}</td><td>${point.residual === undefined ? "no ground nearby" : cm(point.residual)}</td></tr>`,
          )
          .join("")}</tbody></table>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Survey quality report · ${escape(details.name)}</title>
<style>
body{margin:0;background:#fff;color:#151a21;font:15px/1.55 "Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 56px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px;border-bottom:2px solid #151a21;padding-bottom:4px}
.meta{color:#5b6573;margin:0 0 20px}
.grade{display:inline-block;padding:4px 10px;border-radius:4px;background:#e2f3ea;color:#1f6f4b;font-weight:700}
table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #dde1e5;font-variant-numeric:tabular-nums}
thead th{background:#f4f5f2;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573}
img{max-width:100%;image-rendering:pixelated;border:1px solid #dde1e5}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:#5b6573;margin-top:6px}.legend i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-2px}
.note{font-size:13px;color:#5b6573}
</style></head><body><main>
<h1>Survey quality report</h1>
<p class="meta">${escape(details.name)} · ${escape(details.crs)} · ${report.pointCount.toLocaleString("en-US")} points · ${created}</p>
<p><span class="grade">${escape(level)}</span> USGS Lidar Base Specification quality level met by the ${accuracy === undefined ? "point density (accuracy not checked)" : "point density and vertical accuracy"}.</p>

<h2>Point density</h2>
<table><tbody>${rows([
    ["Median", `${density.median.toFixed(1)} ${density.firstReturnsOnly ? "first returns" : "points"} per m²`],
    ["Mean", `${density.mean.toFixed(1)} per m²`],
    ["95% of the area reaches", `${density.p5.toFixed(1)} per m²`],
    ["Area below 8 per m² (QL1)", percent(density.belowEight)],
    ["Area below 2 per m² (QL2)", percent(density.belowTwo)],
    ["Grid", `${density.cellSize} m cells, ${density.cols} × ${density.rows}`],
  ])}</tbody></table>
<img src="${details.heatmapUrl}" alt="Point density heatmap, north up">
<div class="legend"><span><i style="background:#d63031"></i>No returns</span><span><i style="background:#e86e2c"></i>Below 2 per m²</span><span><i style="background:#e8b034"></i>2 to 8 per m²</span><span><i style="background:#3c9a5c"></i>8 per m² and up</span></div>

<h2>Coverage</h2>
<table><tbody>${rows([
    ["Footprint", `${Math.round(coverage.footprintArea).toLocaleString("en-US")} m²`],
    ["Without returns", `${Math.round(coverage.gapArea).toLocaleString("en-US")} m² (${percent(coverage.gapShare)}) in ${coverage.gapRegions} patches`],
    ["Largest patch", `${Math.round(coverage.largestGapArea).toLocaleString("en-US")} m²`],
  ])}</tbody></table>
<p class="note">Water, fresh asphalt and glass return little or nothing to a laser; gaps over them are expected. Gaps elsewhere mean a missed strip or an occluded area.</p>

<h2>Strip alignment</h2>
${strips === undefined ? "" : `<p>${strips.strips.length} flight lines; ${percent(strips.overlapShare)} of the footprint seen by more than one. Overall RMS offset on flat ground: <strong>${cm(strips.rmsOffset)}</strong>.</p>`}
${stripRows}

<h2>Noise</h2>
<p>${noise.labelled ? `${noise.points.toLocaleString("en-US")} points (${percent(noise.share)}) labelled as noise (ASPRS classes 7 and 18) and left out of every figure above.` : "No classes in the scan: noise has not been identified."}</p>

<h2>Vertical accuracy</h2>
${
  accuracy === undefined
    ? ""
    : `<table><tbody>${rows([
        ["Checkpoints measured", `${accuracy.measured} of ${accuracy.checkpoints.length}`],
        ["RMSEz", cm(accuracy.rmsez)],
        ["Vertical accuracy at 95% (1.96 × RMSEz)", cm(accuracy.nva95)],
        ["Mean error", cm(accuracy.meanError)],
        ["Largest error", cm(accuracy.largestError)],
        ["Surface from", accuracy.fromGround ? "ground-classified points" : "lowest points (no ground class)"],
      ])}</tbody></table>`
}
${checkpointRows}

<h2>Quality levels</h2>
<table><thead><tr><th>Level</th><th>Density</th><th>RMSEz</th></tr></thead><tbody>${qualityLevels
    .map((entry) => `<tr><td>${entry.name}</td><td>≥ ${entry.density} per m²</td><td>≤ ${cm(entry.rmsez)}</td></tr>`)
    .join("")}</tbody></table>
<p class="note">Produced by Vertex LiDAR on the analyst's own device. Density counts first returns on a ${density.cellSize} m grid; strip offsets compare the mean heights of each flight line in flat cells both saw.</p>
</main></body></html>`;
}
