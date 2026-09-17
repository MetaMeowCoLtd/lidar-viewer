import { calculateBounds, type PointCloudBounds } from "../../src/index.js";

/**
 * Synthetic aerial scans with a known answer: every point knows whether it is
 * ground, part of a particular building or tree, some other structure, or
 * noise. Positions are in viewer axes, y up.
 *
 * Sampling imitates an airborne scanner looking down. Each pulse lands at a
 * random spot, returns first from the highest surface there, and when that
 * surface is a canopy it may return again from inside the crown and from the
 * ground beneath. Every return of a pulse records how many returns the pulse
 * produced, as a LAS file would. Walls, which a scanner barely sees from above,
 * are sampled sparsely.
 */
export const truth = { ground: 0, building: 1, tree: 2, other: 3, noise: 4 } as const;

export interface TruthBuilding {
  readonly id: number;
  /** Buildings sharing a group are one object on the ground, such as a terrace. */
  readonly group: number;
  readonly footprintArea: number;
  readonly roofTop: number;
}

export interface TruthTree {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

export interface AerialScene {
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly numberOfReturns: Uint8Array;
  /** Exact height above the terrain surface, standing in for a perfect ground filter. */
  readonly heightAboveGround: Float32Array;
  /** Ground as class 2, everything else unclassified - what ground detection hands over. */
  readonly groundClassification: Uint8Array;
  readonly kind: Uint8Array;
  /** Building or tree id for building and tree points, otherwise zero. */
  readonly instance: Int32Array;
  readonly buildings: readonly TruthBuilding[];
  readonly trees: readonly TruthTree[];
}

type Surface = (x: number, z: number) => number | undefined;

interface Structure {
  readonly kind: number;
  readonly instance: number;
  /** Height of the structure's top surface at a spot, or undefined outside it. */
  readonly surface: Surface;
  readonly canopy?: { readonly base: number };
  readonly footprintCells: (visit: (x: number, z: number) => void, spacing: number) => void;
}

export function buildAerialScene(options: { seed: number; density?: number; halfSize?: number; tower?: boolean }): AerialScene {
  const random = seeded(options.seed);
  const density = options.density ?? 6;
  const half = options.halfSize ?? 150;
  const terrain = (x: number, z: number) => 3 * Math.sin(x / 55) + 2.5 * Math.cos(z / 47) + 0.04 * x;

  const structures: Structure[] = [];
  const buildings: TruthBuilding[] = [];
  const trees: TruthTree[] = [];

  const rectangle = (cx: number, cz: number, hw: number, hd: number) => (x: number, z: number) =>
    Math.abs(x - cx) <= hw && Math.abs(z - cz) <= hd;

  /** Highest terrain under a footprint, so a building sits level on sloping ground. */
  const pad = (inside: (x: number, z: number) => boolean, cx: number, cz: number, reach: number) => {
    let highest = -Infinity;
    for (let u = -reach; u <= reach; u += 1) {
      for (let v = -reach; v <= reach; v += 1) {
        if (inside(cx + u, cz + v)) highest = Math.max(highest, terrain(cx + u, cz + v));
      }
    }
    return highest;
  };

  const addBuilding = (
    inside: (x: number, z: number) => boolean,
    roof: (x: number, z: number, base: number) => number,
    cx: number,
    cz: number,
    reach: number,
    area: number,
    group?: number,
  ) => {
    const id = buildings.length + 1;
    const base = pad(inside, cx, cz, reach);
    // Measured the way a viewer measures it: above the ground under each part
    // of the roof, not above the pad, then the 95th percentile across the roof.
    const clearances: number[] = [];
    for (let u = -reach; u <= reach; u += 0.5) {
      for (let v = -reach; v <= reach; v += 0.5) {
        if (inside(cx + u, cz + v)) clearances.push(roof(cx + u, cz + v, base) - terrain(cx + u, cz + v));
      }
    }
    clearances.sort((a, b) => a - b);
    const roofTop = clearances[Math.floor(0.95 * (clearances.length - 1))]!;
    buildings.push({ id, group: group ?? id, footprintArea: area, roofTop });
    structures.push({
      kind: truth.building,
      instance: id,
      surface: (x, z) => (inside(x, z) ? roof(x, z, base) : undefined),
      footprintCells: (visit, spacing) => {
        for (let u = -reach; u <= reach; u += spacing) {
          for (let v = -reach; v <= reach; v += spacing) if (inside(cx + u, cz + v)) visit(cx + u, cz + v);
        }
      },
    });
  };

  const flat = (cx: number, cz: number, hw: number, hd: number, height: number, group?: number) =>
    addBuilding(rectangle(cx, cz, hw, hd), (_x, _z, base) => base + height, cx, cz, Math.max(hw, hd), 4 * hw * hd, group);

  const gable = (cx: number, cz: number, hw: number, hd: number, eave: number, rise: number, ridgeAlongX: boolean) =>
    addBuilding(
      rectangle(cx, cz, hw, hd),
      (x, z, base) => {
        const across = ridgeAlongX ? Math.abs(z - cz) / hd : Math.abs(x - cx) / hw;
        return base + eave + rise * (1 - across);
      },
      cx,
      cz,
      Math.max(hw, hd),
      4 * hw * hd,
    );

  const lShape = (cx: number, cz: number, height: number) => {
    const armA = rectangle(cx, cz, 12, 5);
    const armB = rectangle(cx - 7, cz + 8, 5, 8);
    addBuilding((x, z) => armA(x, z) || armB(x, z), (_x, _z, base) => base + height, cx, cz + 4, 16, 24 * 10 + 10 * 16 - 10 * 5);
  };

  const addTree = (x: number, z: number, radius: number, height: number) => {
    const id = trees.length + 1;
    const foot = terrain(x, z);
    const base = Math.max(1.5, height * 0.3);
    trees.push({ id, x, z, radius, height });
    const phase = random() * Math.PI * 2;
    structures.push({
      kind: truth.tree,
      instance: id,
      canopy: { base: foot + base },
      surface: (px, pz) => {
        const distance = Math.hypot(px - x, pz - z);
        if (distance > radius) return undefined;
        const dome = Math.sqrt(1 - (distance / radius) ** 2);
        // Clumps of foliage make a canopy lumpy at every scale.
        const clumps = 0.45 * Math.sin((px - x) * 1.9 + phase) * Math.cos((pz - z) * 1.7 - phase);
        return foot + base + (height - base) * dome + clumps + (random() - 0.5) * 0.5;
      },
      footprintCells: (visit, spacing) => {
        for (let u = -radius; u <= radius; u += spacing) {
          for (let v = -radius; v <= radius; v += spacing) if (u * u + v * v <= radius * radius) visit(x + u, z + v);
        }
      },
    });
  };

  const addOther = (cx: number, cz: number, hw: number, hd: number, height: number, vegetation = false) => {
    const inside = rectangle(cx, cz, hw, hd);
    structures.push({
      kind: truth.other,
      instance: 0,
      ...(vegetation ? { canopy: { base: terrain(cx, cz) + height * 0.2 } } : {}),
      surface: (x, z) => (inside(x, z) ? terrain(x, z) + height + (vegetation ? (random() - 0.5) * 0.4 : 0) : undefined),
      footprintCells: (visit, spacing) => {
        for (let u = -hw; u <= hw; u += spacing) for (let v = -hd; v <= hd; v += spacing) visit(cx + u, cz + v);
      },
    });
  };

  // Buildings. The terraced pair shares a wall and a roofline, so it is one
  // object on the ground; the pair beside it is 2.5 m apart and is two.
  flat(-100, -100, 10, 7, 8);
  flat(-40, -110, 15, 12.5, 18);
  gable(40, -100, 6, 4.5, 5, 3, true);
  gable(100, -100, 7, 5, 6, 4.5, false);
  lShape(-100, -20, 7);
  flat(-30, -20, 8, 6, 4);
  flat(35, -20, 5, 6, 9, 100);
  flat(45, -20, 5, 6, 9, 100);
  flat(95, -25, 6, 6, 10);
  flat(109.5, -25, 6, 6, 10);
  flat(-80, 95, 20, 15, 11);
  if (options.tower === true) {
    // A 120 m tower whose top is covered in plant and structure up to 6 m
    // high, so from above it is as rough and deep as a canopy.
    addBuilding(
      rectangle(132, 3, 15, 15),
      (_x, _z, base) => base + 120 + (random() < 0.5 ? random() * 6 : 0),
      132,
      3,
      15,
      900,
    );
  }

  // Trees: isolated, overlapping pairs, and a cluster of three.
  const isolated: [number, number, number, number][] = [
    [-20, 40, 4, 12], [5, 45, 3, 9], [30, 38, 5.5, 18], [60, 45, 2.5, 6], [85, 40, 4.5, 15], [120, 45, 3.5, 11],
    [-130, 40, 3, 8], [-60, 45, 6, 22], [15, 125, 4, 13], [55, 130, 3, 7], [95, 128, 5, 16], [130, 120, 2.5, 5.5],
  ];
  for (const [x, z, radius, height] of isolated) addTree(x, z, radius, height);
  for (const [x, z, r1, h1, r2, h2] of [
    [-10, 85, 4, 12, 3.5, 10],
    [40, 85, 5, 17, 4.5, 14],
    [95, 85, 3, 9, 3, 9.5],
  ] as const) {
    addTree(x, z, r1, h1);
    addTree(x + 0.85 * (r1 + r2), z, r2, h2);
  }
  addTree(-10, 125, 4, 13);
  addTree(-3.5, 131, 3.5, 11);
  addTree(-15, 132, 3.5, 10);

  // Things that must not be counted.
  addOther(-130, -60, 1.5, 2, 2.6);
  addOther(0, -60, 0.6, 9, 1.8, true);
  addOther(40, -60, 0.6, 9, 2.8, true);
  addOther(80, -60, 0.15, 7.5, 2.5);
  for (const [x, z] of [[-60, -60], [-45, -60], [-30, -60], [120, -60]] as const) addOther(x, z, 0.15, 0.15, 7);
  for (const [x, z] of [[-60, 10], [-50, 10], [0, 10]] as const) addOther(x, z, 2.25, 0.9, 1.5);

  const positions: number[] = [];
  const returns: number[] = [];
  const hag: number[] = [];
  const kinds: number[] = [];
  const instances: number[] = [];
  const push = (x: number, y: number, z: number, pulseReturns: number, kind: number, instance: number) => {
    positions.push(x, y, z);
    returns.push(pulseReturns);
    hag.push(y - terrain(x, z));
    kinds.push(kind);
    instances.push(instance);
  };

  const pulses = Math.round(4 * half * half * density);
  for (let pulse = 0; pulse < pulses; pulse += 1) {
    const x = (random() - 0.5) * 2 * half;
    const z = (random() - 0.5) * 2 * half;
    let highest: Structure | undefined;
    let highestY = -Infinity;
    for (const structure of structures) {
      const y = structure.surface(x, z);
      if (y !== undefined && y > highestY) {
        highest = structure;
        highestY = y;
      }
    }
    const ground = terrain(x, z) + (random() - 0.5) * 0.05;
    if (highest === undefined) {
      push(x, ground, z, 1, truth.ground, 0);
      continue;
    }
    if (highest.canopy === undefined) {
      // A roof edge splits the pulse; most of the roof does not.
      push(x, highestY + (random() - 0.5) * 0.04, z, 1, highest.kind, highest.instance);
      continue;
    }
    const inner = random() < 0.6 ? 1 + Math.floor(random() * 2) : 0;
    const reachesGround = random() < 0.35;
    const total = 1 + inner + (reachesGround ? 1 : 0);
    push(x, highestY, z, total, highest.kind, highest.instance);
    for (let index = 0; index < inner; index += 1) {
      const y = highest.canopy.base + random() * Math.max(0.1, highestY - highest.canopy.base);
      push(x, y, z, total, highest.kind, highest.instance);
    }
    if (reachesGround) push(x, ground, z, total, truth.ground, 0);
  }

  // Walls, sparse from the air.
  for (const structure of structures) {
    if (structure.kind !== truth.building) continue;
    structure.footprintCells((x, z) => {
      const onEdge = ([[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]] as const).some(([dx, dz]) => structure.surface(x + dx, z + dz) === undefined);
      if (!onEdge || random() > 0.4 || Math.abs(x) > half || Math.abs(z) > half) return;
      const top = structure.surface(x, z)!;
      const foot = terrain(x, z);
      push(x, foot + random() * (top - foot), z, 1, structure.kind, structure.instance);
    }, 0.5);
  }

  // A few deep outliers, as real scans carry.
  for (let index = 0; index < 60; index += 1) {
    const x = (random() - 0.5) * 2 * half;
    const z = (random() - 0.5) * 2 * half;
    push(x, terrain(x, z) - 3 - random() * 6, z, 1, truth.noise, 0);
  }

  const array = Float32Array.from(positions);
  const kind = Uint8Array.from(kinds);
  return {
    positions: array,
    bounds: calculateBounds(array),
    numberOfReturns: Uint8Array.from(returns),
    heightAboveGround: Float32Array.from(hag),
    groundClassification: Uint8Array.from(kinds, (value) => (value === truth.ground ? 2 : value === truth.noise ? 7 : 1)),
    kind,
    instance: Int32Array.from(instances),
    buildings,
    trees,
  };
}

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
