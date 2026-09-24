import { describe, expect, it } from "vitest";
import { PointCloud } from "../src/core/point-cloud.js";
import { buildQualityReport, parseCheckpoints } from "../src/core/quality-report.js";

/**
 * A flat 40 × 40 m survey flown as two strips that overlap in the middle
 * third, strip 2 sitting `offset` metres above strip 1, with a 4 × 4 m hole.
 * Points every 0.25 m per strip: 16 per square metre each.
 */
function survey(offset: number): PointCloud {
  const positions: number[] = [];
  const sources: number[] = [];
  for (let x = 0.125; x < 40; x += 0.25) {
    for (let z = 0.125; z < 40; z += 0.25) {
      if (x > 10 && x < 14 && z > 10 && z < 14) continue;
      if (z < 26) {
        positions.push(x, 5, z);
        sources.push(1);
      }
      if (z > 14) {
        positions.push(x + 0.06, 5 + offset, z + 0.06);
        sources.push(2);
      }
    }
  }
  return new PointCloud({ positions: new Float32Array(positions), pointSourceId: new Uint16Array(sources), origin: [500_000, 100, -4_000_000] });
}

function report(cloud: PointCloud, checkpoints?: Parameters<typeof buildQualityReport>[0]["checkpoints"]) {
  return buildQualityReport({
    positions: cloud.positions,
    bounds: cloud.bounds,
    origin: cloud.origin,
    pointSourceId: cloud.pointSourceId,
    checkpoints,
  });
}

describe("buildQualityReport", () => {
  it("measures density, doubled where strips overlap", () => {
    const { density } = report(survey(0));
    expect(density.median).toBe(16);
    expect(density.grid[Math.floor(20) * density.cols + 20]).toBe(32);
  });

  it("finds a hole in the coverage and sizes it", () => {
    const { coverage } = report(survey(0));
    expect(coverage.gapRegions).toBe(1);
    expect(coverage.largestGapArea).toBeGreaterThanOrEqual(9);
    expect(coverage.largestGapArea).toBeLessThanOrEqual(16);
  });

  it("measures the height offset between two overlapping strips", () => {
    const { strips } = report(survey(0.05));
    expect(strips?.strips).toEqual([1, 2]);
    expect(strips?.pairs).toHaveLength(1);
    expect(strips!.pairs[0]!.medianOffset).toBeCloseTo(0.05, 3);
    expect(strips!.overlapShare).toBeGreaterThan(0.25);
  });

  it("reports vertical accuracy at checkpoints in map coordinates", () => {
    // The surface is at 105 m; one checkpoint 2 cm low, one 2 cm high, one off the scan.
    const cloud = survey(0);
    const accuracy = report(cloud, [
      { name: "A", east: 500_005, north: 4_000_000 - 5, elevation: 104.98 },
      { name: "B", east: 500_030, north: 4_000_000 - 8, elevation: 105.02 },
      { name: "C", east: 600_000, north: 4_000_000, elevation: 105 },
    ]).accuracy!;
    expect(accuracy.measured).toBe(2);
    expect(accuracy.checkpoints[0]!.residual).toBeCloseTo(0.02, 4);
    expect(accuracy.checkpoints[1]!.residual).toBeCloseTo(-0.02, 4);
    expect(accuracy.checkpoints[2]!.residual).toBeUndefined();
    expect(accuracy.rmsez).toBeCloseTo(0.02, 4);
    expect(accuracy.nva95).toBeCloseTo(0.0392, 4);
  });

  it("grades the survey against the USGS quality levels", () => {
    expect(report(survey(0)).qualityLevel).toBe("QL1");
    const accurate = report(survey(0), [{ name: "A", east: 500_005, north: 4_000_000 - 5, elevation: 105.01 }]);
    expect(accurate.qualityLevel).toBe("QL0");
  });
});

describe("parseCheckpoints", () => {
  it("reads named and unnamed rows and skips headers", () => {
    const checkpoints = parseCheckpoints("name,east,north,z\nGCP1, 451200.5, 4473600.25, 612.3\n451201;4473601;613\n\nnot,a,number,row");
    expect(checkpoints).toEqual([
      { name: "GCP1", east: 451200.5, north: 4473600.25, elevation: 612.3 },
      { name: "CP2", east: 451201, north: 4473601, elevation: 613 },
    ]);
  });
});
