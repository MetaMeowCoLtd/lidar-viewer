import { qualityLevels, type CheckStatus, type QualityReport } from "../core/quality-report.js";
import { classificationName } from "../core/point-cloud-classification.js";

/** Colour of a density cell: gaps red, thin coverage amber, then green brightening with density. */
export function densityColour(density: number, median: number): readonly [number, number, number] {
  if (Number.isNaN(density)) return [0, 0, 0];
  if (density === 0) return [214, 48, 49];
  if (density < 2) return [232, 110, 44];
  if (density < 8) return [232, 176, 52];
  const t = Math.min(1, density / Math.max(8, median * 2));
  return [Math.round(40 + 60 * t), Math.round(120 + 100 * t), Math.round(70 + 40 * t)];
}

/**
 * The density grid as an image, north up, about `width` pixels across: grids
 * larger than that are averaged down (a city-sized grid at full resolution
 * made a 10 MB report), and the image is WebP where the browser can write it.
 */
export function densityHeatmapUrl(report: QualityReport, width = 1200): string {
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
  // Small grids are blown up with hard pixel edges; large ones shrunk with smoothing.
  const scale = cols >= width ? width / cols : Math.max(1, Math.round(width / cols));
  const scaled = document.createElement("canvas");
  scaled.width = Math.max(1, Math.round(cols * scale));
  scaled.height = Math.max(1, Math.round(rows * scale));
  const target = scaled.getContext("2d")!;
  target.imageSmoothingEnabled = scale < 1;
  target.imageSmoothingQuality = "high";
  target.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  const webp = scaled.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : scaled.toDataURL("image/png");
}

const escape = (text: string) => text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
const cm = (metres: number) => `${(metres * 100).toFixed(1)} cm`;
const percent = (share: number) => `${(share * 100).toFixed(share < 0.01 ? 2 : 1)} %`;

const statusLabel: Record<CheckStatus, string> = { pass: "Pass", fail: "Fail", review: "Review", skipped: "Not checked" };
const statusColour: Record<CheckStatus, string> = { pass: "#1f7a4f", fail: "#b42318", review: "#9a5b00", skipped: "#667085" };

/**
 * The report as one self-contained HTML file - styles and the heatmap inline -
 * that a client can open anywhere and print to PDF. The verdict comes first,
 * each check with its figure and the limit it was held to; the evidence
 * follows, section by section.
 */
export function qualityReportHtml(report: QualityReport, details: { name: string; crs: string; heatmapUrl: string; createdAt?: Date }): string {
  const { density, coverage, strips, noise, accuracy, precision, thinning } = report;
  const created = (details.createdAt ?? new Date()).toISOString().slice(0, 10);
  const level = report.qualityLevel ?? "Below QL3";
  const rows = (entries: ReadonlyArray<readonly [string, string]>) => entries.map(([label, value]) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`).join("");
  const count = (value: number) => value.toLocaleString("en-US");
  const thinned = thinning !== undefined && thinning.total > thinning.loaded;

  const verdict = report.checks
    .map((check) => `<tr><td><span class="status" style="background:${statusColour[check.status]}">${statusLabel[check.status]}</span></td><th>${escape(check.name)}</th><td>${escape(check.detail)}</td></tr>`)
    .join("");
  const stripRows =
    strips === undefined
      ? `<p>The scan does not record flight lines (LAS point source IDs), so strips cannot be compared. Deliveries that keep each point's source ID allow this check.</p>`
      : strips.pairs.length === 0
        ? `<p>${strips.strips.length < 2 ? "Only one flight line in the scan." : "The strips do not overlap on enough flat ground to compare."}</p>`
        : `<table><thead><tr><th>Strips</th><th>Flat cells compared</th><th>Median offset</th><th>RMS offset</th></tr></thead><tbody>${strips.pairs
            .map((pair) => `<tr><td>${pair.a} → ${pair.b}</td><td>${count(pair.cells)}</td><td>${cm(pair.medianOffset)}</td><td>${cm(pair.rmsOffset)}</td></tr>`)
            .join("")}</tbody></table>`;
  const checkpointRows =
    accuracy === undefined
      ? `<p>No checkpoints were supplied. Survey a set on hard, open ground (at least 20 for a formal ASPRS assessment) and load them as a CSV of name, easting, northing, elevation in the scan's coordinate system.</p>`
      : `<table><thead><tr><th>Checkpoint</th><th>Easting</th><th>Northing</th><th>Elevation</th><th>Scan − checkpoint</th></tr></thead><tbody>${accuracy.checkpoints
          .map(
            (point) =>
              `<tr><td>${escape(point.name)}</td><td>${point.east.toFixed(3)}</td><td>${point.north.toFixed(3)}</td><td>${point.elevation.toFixed(3)}</td><td>${point.residual === undefined ? "no ground nearby" : cm(point.residual)}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  const classRows =
    report.classes.length === 0
      ? `<p>The scan carries no classes.</p>`
      : `<table><thead><tr><th>Class</th><th>Points</th><th>Share</th></tr></thead><tbody>${report.classes
          .map((entry) => `<tr><td>${entry.code} · ${escape(classificationName(entry.code))}</td><td>${count(entry.count)}</td><td>${percent(entry.count / report.pointCount)}</td></tr>`)
          .join("")}</tbody></table>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Survey quality report · ${escape(details.name)}</title>
<style>
body{margin:0;background:#fff;color:#151a21;font:15px/1.55 "Segoe UI",system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 20px 56px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px;border-bottom:2px solid #151a21;padding-bottom:4px}
.meta{color:#5b6573;margin:0 0 20px}
.grade{display:inline-block;padding:4px 10px;border-radius:4px;background:#e2f3ea;color:#1f6f4b;font-weight:700}
.warn{padding:10px 14px;border-left:4px solid #9a5b00;background:#fbf3e6;margin:12px 0}
.status{display:inline-block;min-width:72px;padding:2px 8px;border-radius:3px;color:#fff;font-size:12px;font-weight:700;text-align:center}
table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #dde1e5;font-variant-numeric:tabular-nums;vertical-align:top}
thead th{background:#f4f5f2;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573}
img{max-width:100%;border:1px solid #dde1e5}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:#5b6573;margin-top:6px}.legend i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-2px}
.note{font-size:13px;color:#5b6573}
</style></head><body><main>
<h1>Survey quality report</h1>
<p class="meta">${escape(details.name)} · ${escape(details.crs)} · ${count(thinned ? thinning.total : report.pointCount)} points · ${created}</p>
<p><span class="grade">${escape(level)}</span> USGS Lidar Base Specification quality level met by the ${accuracy === undefined ? "point density (accuracy not checked)" : "point density and vertical accuracy"}.</p>
${
  thinned
    ? `<p class="warn">This scan was thinned evenly on import to ${count(thinning.loaded)} of its ${count(thinning.total)} points. Densities for the file are scaled up by ${(thinning.total / thinning.loaded).toFixed(2)}×; voids, precision and the heatmap were measured on the thinned copy, which makes them conservative.</p>`
    : ""
}

<h2>Verdict</h2>
<table><tbody>${verdict}</tbody></table>
<p class="note">Held to QL2, the least the USGS accepts for 3DEP collection. "Review" marks findings a person should look at before rejecting the data.</p>

<h2>Point density</h2>
<table><tbody>${rows([
    ["Median", `${density.fullMedian.toFixed(1)} ${density.firstReturnsOnly ? "first returns" : "points"} per m²${thinned ? ` (${density.median.toFixed(1)} loaded)` : ""}`],
    ["Nominal point spacing", `${density.spacing.toFixed(2)} m`],
    ["95% of the area reaches", `${density.p5.toFixed(1)} per m²${thinned ? " loaded" : ""}`],
    ["Area below 8 per m² (QL1)", `${percent(density.belowEight)}${thinned ? " loaded" : ""}`],
    ["Area below 2 per m² (QL2)", `${percent(density.belowTwo)}${thinned ? " loaded" : ""}`],
    ["Grid", `${density.cellSize} m cells, ${density.cols} × ${density.rows}`],
  ])}</tbody></table>
<img src="${details.heatmapUrl}" alt="Point density heatmap, north up">
<div class="legend"><span><i style="background:#d63031"></i>No returns</span><span><i style="background:#e86e2c"></i>Below 2 per m²</span><span><i style="background:#e8b034"></i>2 to 8 per m²</span><span><i style="background:#3c9a5c"></i>8 per m² and up</span></div>

<h2>Coverage and voids</h2>
<table><tbody>${rows([
    ["Footprint", `${count(Math.round(coverage.footprintArea))} m²`],
    ["Void size (4 × spacing)²", `${coverage.voidThreshold.toFixed(1)} m²`],
    ["Voids", `${count(coverage.voids)}, ${count(Math.round(coverage.voidArea))} m² in all; largest ${count(Math.round(coverage.largestGapArea))} m²`],
    ["Scattered empty cells", `${count(coverage.scatteredCells)} cells too small to be voids (${percent(coverage.gapShare)} of the footprint is empty in all)`],
  ])}</tbody></table>
<p class="note">A void is an area of (4 × nominal spacing)² or more with no first returns (USGS Lidar Base Specification). Voids over water, low-reflectivity surfaces such as fresh asphalt and dark roofing, and building shadows are acceptable; others call for a re-flight.</p>

<h2>Flat-surface precision</h2>
${
  precision === undefined
    ? "<p>Not enough flat, level ground to measure.</p>"
    : `<table><tbody>${rows([
        ["Hard, level surfaces", `${cm(precision.hardSurface)} RMS`],
        ["All level ground", `${cm(precision.allLevel)} RMS`],
        ["Measured on", `${count(precision.cells)} cells of ${precision.cellSize} m, ${precision.fromGround ? "ground-classified points" : "single returns"}, one flight line per cell`],
      ])}</tbody></table>
<p class="note">Smooth surface repeatability: the spread of heights a single pass measures on a flat surface, about the cell's tilt. The smoothest quarter of level cells stands for the hard surfaces (roads, car parks, flat roofs) the USGS specifies; grass raises the all-ground figure.</p>`
}

<h2>Strip alignment</h2>
${strips === undefined ? "" : `<p>${strips.strips.length} flight lines; ${percent(strips.overlapShare)} of the footprint seen by more than one. Overall RMS offset on flat ground: <strong>${cm(strips.rmsOffset)}</strong>.</p>`}
${stripRows}

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

<h2>Content</h2>
${classRows}
${
  report.returns === undefined
    ? ""
    : `<p>${percent(report.returns.single)} of points are single returns; pulses came back up to ${report.returns.most} times. Multiple returns are what let a scan see ground under vegetation.</p>`
}
<p>${noise.labelled ? `${count(noise.points)} points (${percent(noise.share)}) labelled as noise (ASPRS classes 7 and 18) and left out of every figure above.` : "Noise has not been identified."}</p>

<h2>Quality levels</h2>
<table><thead><tr><th>Level</th><th>Density</th><th>Precision (RMS)</th><th>Strip overlap</th><th>RMSEz</th></tr></thead><tbody>${qualityLevels
    .map((entry) => `<tr><td>${entry.name}</td><td>≥ ${entry.density} per m²</td><td>≤ ${cm(entry.precision)}</td><td>≤ ${cm(entry.overlap)}</td><td>≤ ${cm(entry.rmsez)}</td></tr>`)
    .join("")}</tbody></table>
<p class="note">Produced by Vertex LiDAR on the analyst's own device. Density counts first returns on a ${density.cellSize} m grid; strip offsets compare the mean heights of each flight line in flat cells both saw.</p>
</main></body></html>`;
}
