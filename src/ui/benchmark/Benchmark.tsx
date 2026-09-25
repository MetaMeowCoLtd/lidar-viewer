import { useEffect, useState } from "react";
import { Icon } from "../icons.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { appHref, landingHref } from "../router.js";
import { PointCloud } from "../../core/point-cloud.js";
import { generateSampleCloud } from "../../core/sample-job.js";
import { defaultNoiseDetectionOptions, findIsolated, noiseSearchRadius } from "../../core/noise-detection.js";
import { markObjects, prepareGround, type GroundPreparation } from "../../core/ground-detection.js";
import { VoxelGridDownsampler } from "../../core/voxel-grid-downsampler.js";
import { viewerConfig } from "../../config.js";
import { requestGpu, gpuSupported, type GpuContext } from "../../gpu/gpu-context.js";
import { gpuFindIsolated } from "../../gpu/isolated-points.js";
import { gpuMarkObjects } from "../../gpu/ground-openings.js";
import { gpuVoxelThin } from "../../gpu/voxel-thinning.js";

interface Row {
  readonly workload: string;
  readonly size: string;
  readonly cpuMs: number;
  readonly gpuMs: number | undefined;
  readonly agreement: string;
}

const sizes = [500_000, 1_000_000, 2_000_000] as const;

const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function timeCpu<T>(run: () => T, repeats: number): Promise<{ ms: number; value: T }> {
  const times: number[] = [];
  let value!: T;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    value = run();
    times.push(performance.now() - started);
    await pause();
  }
  return { ms: median(times), value };
}

/** GPU timings end to end - upload, compute, read back - after one warm-up run that compiles the shaders. */
async function timeGpu<T>(run: () => Promise<T>, repeats: number): Promise<{ ms: number; value: T }> {
  await run();
  const times: number[] = [];
  let value!: T;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    value = await run();
    times.push(performance.now() - started);
  }
  return { ms: median(times), value };
}

/** A 2048 × 2048 m lowest surface - rolling hills with buildings on them - for the opening filter at scale. */
function syntheticGrid(): GroundPreparation {
  const cols = 2048;
  const rows = 2048;
  const lowest = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let height = 40 + 12 * Math.sin(col / 173) * Math.cos(row / 211) + 3 * Math.sin((col + row) / 37);
      // Blocks of buildings on a 60 m grid.
      if (col % 60 < 24 && row % 60 < 18) height += 8 + ((col * 7 + row * 13) % 5);
      lowest[row * cols + col] = height;
    }
  }
  return { grid: { originX: 0, originZ: 0, cellSize: 1, cols, rows }, lowest, pitsRaised: 0, maxRadius: 18 };
}

function agreementOf(a: Uint8Array, b: Uint8Array): string {
  let same = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] === b[index]) same += 1;
  return `${((100 * same) / a.length).toFixed(3)} % identical`;
}

/**
 * Side by side, the CPU and WebGPU versions of the heavy preprocessing stages,
 * on a simulated factory survey and on a large synthetic grid: how long each takes,
 * and whether they agree.
 */
export function Benchmark() {
  const [gpu, setGpu] = useState<GpuContext | null | undefined>(null);
  const [pointCount, setPointCount] = useState<number>(1_000_000);
  const [includeLargeGrid, setIncludeLargeGrid] = useState(true);
  const [stage, setStage] = useState<string>();
  const [rows, setRows] = useState<Row[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void requestGpu().then(setGpu);
  }, []);

  const run = async () => {
    setRows([]);
    setCopied(false);
    const results: Row[] = [];
    const add = (row: Row) => {
      results.push(row);
      setRows([...results]);
    };
    try {
      setStage("Simulating a factory survey");
      const cloud = await generateSampleCloud({ pointCount, seed: 21, name: "benchmark" });
      const count = `${(cloud.pointCount / 1e6).toFixed(1)} M points`;

      // Noise: the radius outlier search.
      setStage("Isolated-point noise test");
      await pause();
      const radius = noiseSearchRadius(cloud.bounds, cloud.pointCount, defaultNoiseDetectionOptions);
      const cpuNoise = await timeCpu(() => findIsolated(cloud.positions, cloud.bounds, radius, defaultNoiseDetectionOptions.minNeighbours), 2);
      const gpuNoise = gpu ? await timeGpu(() => gpuFindIsolated(gpu, cloud.positions, cloud.bounds, radius, defaultNoiseDetectionOptions.minNeighbours), 3) : undefined;
      add({
        workload: "Noise: isolated-point search",
        size: `${count}, ${radius.toFixed(2)} m radius`,
        cpuMs: cpuNoise.ms,
        gpuMs: gpuNoise?.ms,
        agreement: gpuNoise === undefined ? "—" : agreementOf(cpuNoise.value, gpuNoise.value.isolated),
      });

      // Ground: the openings at every window size, on the sample's grid.
      setStage("Ground filter on the sample");
      await pause();
      const prepared = prepareGround({ positions: cloud.positions, bounds: cloud.bounds }, viewerConfig().groundDetection);
      const cpuGround = await timeCpu(() => markObjects(prepared, viewerConfig().groundDetection), 3);
      const gpuGround = gpu ? await timeGpu(() => gpuMarkObjects(gpu, prepared, viewerConfig().groundDetection), 3) : undefined;
      add({
        workload: "Ground: surface openings",
        size: `${prepared.grid.cols} × ${prepared.grid.rows} cells, ${prepared.maxRadius} window sizes`,
        cpuMs: cpuGround.ms,
        gpuMs: gpuGround?.ms,
        agreement: gpuGround === undefined ? "—" : agreementOf(cpuGround.value, gpuGround.value),
      });

      if (includeLargeGrid) {
        setStage("Ground filter on a 2048 × 2048 grid (the CPU run takes a few seconds)");
        await pause();
        const large = syntheticGrid();
        const cpuLarge = await timeCpu(() => markObjects(large, viewerConfig().groundDetection), 1);
        const gpuLarge = gpu ? await timeGpu(() => gpuMarkObjects(gpu, large, viewerConfig().groundDetection), 3) : undefined;
        add({
          workload: "Ground: surface openings at scale",
          size: "2048 × 2048 cells (4.2 km²), 18 window sizes",
          cpuMs: cpuLarge.ms,
          gpuMs: gpuLarge?.ms,
          agreement: gpuLarge === undefined ? "—" : agreementOf(cpuLarge.value, gpuLarge.value),
        });
      }

      // Voxel thinning, positions and colour, at two voxel sizes.
      const plain = new PointCloud({ positions: cloud.positions, ...(cloud.colors === undefined ? {} : { colors: cloud.colors }), bounds: cloud.bounds });
      for (const voxel of [0.25, 1]) {
        setStage(`Voxel thinning at ${voxel} m`);
        await pause();
        const cpuThin = await timeCpu(() => new VoxelGridDownsampler().downsample(plain, { voxelSize: voxel }), 3);
        const gpuThin = gpu ? await timeGpu(() => gpuVoxelThin(gpu, plain.positions, plain.colors, plain.bounds, voxel), 3) : undefined;
        let agreement = "—";
        if (gpuThin !== undefined) {
          // Match each GPU voxel to the CPU one it falls in and measure how far apart their averages are.
          const key = (x: number, y: number, z: number) =>
            `${Math.floor((x - plain.bounds.min[0]) / voxel)},${Math.floor((y - plain.bounds.min[1]) / voxel)},${Math.floor((z - plain.bounds.min[2]) / voxel)}`;
          const cpuCentres = new Map<string, number>();
          const cpu = cpuThin.value.positions;
          for (let index = 0; index < cpu.length; index += 3) cpuCentres.set(key(cpu[index]!, cpu[index + 1]!, cpu[index + 2]!), index);
          // Points exactly on a voxel boundary can fall either side in 32-bit and 64-bit arithmetic, which
          // moves a handful of averages; the share within a millimetre says how many agree exactly.
          let close = 0;
          const gpuPositions = gpuThin.value.positions;
          for (let index = 0; index < gpuPositions.length; index += 3) {
            const at = cpuCentres.get(key(gpuPositions[index]!, gpuPositions[index + 1]!, gpuPositions[index + 2]!));
            if (at === undefined) continue;
            if (Math.hypot(gpuPositions[index]! - cpu[at]!, gpuPositions[index + 1]! - cpu[at + 1]!, gpuPositions[index + 2]! - cpu[at + 2]!) < 0.001) close += 1;
          }
          agreement = `${(cpu.length / 3).toLocaleString("en-US")} vs ${(gpuPositions.length / 3).toLocaleString("en-US")} voxels; ${((100 * close) / (cpu.length / 3)).toFixed(3)} % within 1 mm`;
        }
        add({
          workload: `Voxel thinning, ${voxel} m voxels`,
          size: `${count} → ${(cpuThin.value.pointCount / 1e3).toFixed(0)} K`,
          cpuMs: cpuThin.ms,
          gpuMs: gpuThin?.ms,
          agreement,
        });
      }
      setStage(undefined);
    } catch (error) {
      setStage(error instanceof Error ? `Stopped: ${error.message}` : "Stopped");
    }
  };

  const copy = async () => {
    const report = { adapter: gpu?.adapterName ?? "none", userAgent: navigator.userAgent, results: rows };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const busy = stage !== undefined && !stage.startsWith("Stopped");

  return (
    <div className="bench">
      <header className="bench-top">
        <a className="logo" href={landingHref}>
          <Icon name="logo" className="logo-mark" />
          Vertex LiDAR
        </a>
        <a className="btn" href={appHref}>
          Open the app
        </a>
        <ThemeToggle />
      </header>

      <main className="bench-main">
        <p className="bench-eyebrow">WebGPU compute benchmark</p>
        <h1>CPU against GPU, on the same scan</h1>
        <p className="bench-lede">
          The heaviest preprocessing stages - the noise filter's neighbour search, the ground filter's surface openings and voxel thinning - written
          twice: as JavaScript on the CPU and as WGSL compute shaders on the GPU. Each runs here on a simulated factory survey and, for the ground filter, on a
          large grid, and the results are compared for agreement as well as speed.
        </p>

        <section className="bench-panel">
          <dl className="bench-facts">
            <div>
              <dt>GPU</dt>
              <dd>{gpu === null ? "Checking…" : gpu === undefined ? (gpuSupported() ? "WebGPU refused an adapter" : "No WebGPU in this browser") : gpu.adapterName}</dd>
            </div>
            <div>
              <dt>CPU threads</dt>
              <dd>{navigator.hardwareConcurrency || "?"} (these runs use one)</dd>
            </div>
          </dl>
          <div className="bench-controls">
            <label>
              Sample size
              <select value={pointCount} onChange={(event) => setPointCount(Number(event.target.value))} disabled={busy}>
                {sizes.map((size) => (
                  <option key={size} value={size}>
                    {`${size / 1e6} M points`}
                  </option>
                ))}
              </select>
            </label>
            <label className="bench-check">
              <input type="checkbox" checked={includeLargeGrid} onChange={(event) => setIncludeLargeGrid(event.target.checked)} disabled={busy} />
              Include the 2048 × 2048 ground grid
            </label>
            <button type="button" className="btn btn-primary" disabled={busy || gpu === null} onClick={() => void run()}>
              <Icon name="play" /> {rows.length > 0 ? "Run again" : "Run the benchmark"}
            </button>
          </div>
          {stage === undefined ? null : <p className="bench-stage">{busy ? `${stage}…` : stage}</p>}
        </section>

        {rows.length === 0 ? null : (
          <section className="bench-results">
            <div className="bench-table-wrap">
              <table className="bench-table">
                <thead>
                  <tr>
                    <th>Workload</th>
                    <th>Size</th>
                    <th className="num">CPU</th>
                    <th className="num">GPU</th>
                    <th className="num">Speed-up</th>
                    <th>Agreement</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.workload}>
                      <td>{row.workload}</td>
                      <td>{row.size}</td>
                      <td className="num">{`${row.cpuMs.toFixed(0)} ms`}</td>
                      <td className="num">{row.gpuMs === undefined ? "—" : `${row.gpuMs.toFixed(0)} ms`}</td>
                      <td className="num">{row.gpuMs === undefined ? "—" : `${(row.cpuMs / row.gpuMs).toFixed(1)}×`}</td>
                      <td>{row.agreement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bench-foot">
              <button type="button" className="btn" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy results as JSON"}
              </button>
              <p>
                Medians of repeated runs. GPU times are end to end - uploading the data, running the shaders and reading the answer back - after one
                warm-up run that compiles the shaders. CPU times are single-threaded JavaScript, the same code the analyses run in their workers.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
