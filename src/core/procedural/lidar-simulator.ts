import { clamp, clampByte, gaussian, hash, type Random, type Rgb } from "./sampling.js";
import {
  Cover,
  blockTop,
  buildSite,
  foliageClump,
  groundAt,
  halfDepth,
  halfWidth,
  insideCrown,
  pileTop,
  surfaceAt,
  type Block,
  type Site,
  type Thin,
} from "./survey-site.js";

/**
 * Flies a survey over the site and records what the laser sees, rather than
 * scattering points over its surfaces. That is what makes the result look
 * like a real capture: the scan lines and the denser overlap between flight
 * strips, walls seen only from the side a strip faced, shadows behind
 * buildings, pulses that pass through a canopy leaving returns inside it and
 * sparse ground beneath, conductors caught as dotted lines, and almost nothing
 * back from water.
 *
 * The drone flies six east-west strips at a constant altitude with half its
 * swath overlapping the next; a mirror sweeps each pulse across the track,
 * ±35° from vertical, while the aircraft moves on. Every pulse is traced
 * through a surface model of the site at 0.3 m and through the tree crowns and
 * thin structures, and can come back as up to five returns.
 */

const margin = 4;
const minX = -halfWidth - margin;
const minZ = -halfDepth - margin;
const spanX = (halfWidth + margin) * 2;
const spanZ = (halfDepth + margin) * 2;

const fineCell = 0.3;
const coarseCell = 6;
const shadowCell = 1;
/** Crowns get a finer index of their own: a step through a forest then tests one or two trees, not a dozen. */
const treeCell = 2;

const maxReturns = 5;
/** How far along a pulse two returns must be apart for the receiver to tell them apart. */
const deadZone = 1.2;
const halfFieldOfView = (35 * Math.PI) / 180;
const stripZs = [-150, -90, -30, 30, 90, 150];
const runIn = 32;

// Morning sun from the south-east, 52 degrees up.
const sunElevation = (52 * Math.PI) / 180;
const sunX = Math.cos(sunElevation) * 0.6;
const sunY = Math.sin(sunElevation);
const sunZ = Math.cos(sunElevation) * 0.8;

const bark: Rgb = { r: 92, g: 80, b: 66 };

/** Everything the pulses are traced through, rasterised and indexed once. */
class SiteModel {
  public readonly groundCols = Math.ceil(spanX) + 1;
  public readonly groundRows = Math.ceil(spanZ) + 1;
  public readonly ground = new Float32Array(this.groundCols * this.groundRows);
  public readonly cover = new Uint8Array(this.groundCols * this.groundRows);

  public readonly fineCols = Math.ceil(spanX / fineCell) + 1;
  public readonly fineRows = Math.ceil(spanZ / fineCell) + 1;
  public readonly heights = new Float32Array(this.fineCols * this.fineRows);
  public readonly ids = new Uint16Array(this.fineCols * this.fineRows);

  public readonly coarseCols = Math.ceil(spanX / coarseCell);
  public readonly coarseRows = Math.ceil(spanZ / coarseCell);
  public readonly solidMax = new Float32Array(this.coarseCols * this.coarseRows).fill(Number.NEGATIVE_INFINITY);
  public readonly anyMax = new Float32Array(this.coarseCols * this.coarseRows).fill(Number.NEGATIVE_INFINITY);
  /** The highest a pulse needs stepping through: solid surface or foliage, but not conductors, which are tested exactly. */
  public readonly marchMax = new Float32Array(this.coarseCols * this.coarseRows).fill(Number.NEGATIVE_INFINITY);
  public readonly treeCols = Math.ceil(spanX / treeCell);
  public readonly treeRows = Math.ceil(spanZ / treeCell);
  public treeStart: Int32Array = new Int32Array(0);
  public treeItems: Int32Array = new Int32Array(0);
  public thinStart: Int32Array = new Int32Array(0);
  public thinItems: Int32Array = new Int32Array(0);
  public ceiling = Number.NEGATIVE_INFINITY;
  public highestGround = Number.NEGATIVE_INFINITY;

  public readonly shadowCols = Math.ceil(spanX / shadowCell) + 1;
  public readonly shadowRows = Math.ceil(spanZ / shadowCell) + 1;
  public readonly sunlight = new Uint8Array(this.shadowCols * this.shadowRows);

  public constructor(public readonly site: Site) {
    this.rasteriseGround();
    this.rasteriseObjects();
    this.indexCoarse();
    this.castShadows();
  }

  private rasteriseGround(): void {
    for (let row = 0; row < this.groundRows; row += 1) {
      for (let col = 0; col < this.groundCols; col += 1) {
        const cell = groundAt(minX + col, minZ + row);
        const index = row * this.groundCols + col;
        this.ground[index] = cell.height;
        this.cover[index] = cell.cover;
        this.highestGround = Math.max(this.highestGround, cell.height);
      }
    }
    for (let row = 0; row < this.fineRows; row += 1) {
      const gz = row * fineCell;
      const r0 = Math.min(this.groundRows - 2, Math.floor(gz));
      const tz = gz - r0;
      for (let col = 0; col < this.fineCols; col += 1) {
        const gx = col * fineCell;
        const c0 = Math.min(this.groundCols - 2, Math.floor(gx));
        const tx = gx - c0;
        const i = r0 * this.groundCols + c0;
        const j = i + this.groundCols;
        this.heights[row * this.fineCols + col] =
          (this.ground[i]! * (1 - tx) + this.ground[i + 1]! * tx) * (1 - tz) + (this.ground[j]! * (1 - tx) + this.ground[j + 1]! * tx) * tz;
      }
    }
  }

  private rasteriseObjects(): void {
    const { blocks, piles, trees } = this.site;
    blocks.forEach((b, index) => {
      const reach = b.round ? b.halfX : Math.hypot(b.halfX, b.halfZ);
      this.stamp(b.x - reach, b.z - reach, b.x + reach, b.z + reach, index + 1, (x, z) => {
        const dx = x - b.x;
        const dz = z - b.z;
        return blockTop(b, dx * b.cos + dz * b.sin, -dx * b.sin + dz * b.cos);
      });
    });
    piles.forEach((p, index) => {
      this.stamp(Math.min(p.ax, p.bx) - p.radius, Math.min(p.az, p.bz) - p.radius, Math.max(p.ax, p.bx) + p.radius, Math.max(p.az, p.bz) + p.radius, blocks.length + index + 1, (x, z) => pileTop(p, x, z));
    });
  }

  private stamp(x0: number, z0: number, x1: number, z1: number, id: number, top: (x: number, z: number) => number): void {
    const c0 = clamp(Math.floor((x0 - minX) / fineCell), 0, this.fineCols - 1);
    const c1 = clamp(Math.ceil((x1 - minX) / fineCell), 0, this.fineCols - 1);
    const r0 = clamp(Math.floor((z0 - minZ) / fineCell), 0, this.fineRows - 1);
    const r1 = clamp(Math.ceil((z1 - minZ) / fineCell), 0, this.fineRows - 1);
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        const height = top(minX + col * fineCell, minZ + row * fineCell);
        const index = row * this.fineCols + col;
        if (height > this.heights[index]!) {
          this.heights[index] = height;
          this.ids[index] = id;
        }
      }
    }
  }

  private indexCoarse(): void {
    for (let row = 0; row < this.fineRows; row += 1) {
      const coarseRow = Math.min(this.coarseRows - 1, Math.floor((row * fineCell) / coarseCell));
      for (let col = 0; col < this.fineCols; col += 1) {
        const coarse = coarseRow * this.coarseCols + Math.min(this.coarseCols - 1, Math.floor((col * fineCell) / coarseCell));
        // A little headroom: the surface between samples is interpolated.
        const height = this.heights[row * this.fineCols + col]! + 0.05;
        if (height > this.solidMax[coarse]!) this.solidMax[coarse] = height;
      }
    }
    this.anyMax.set(this.solidMax);
    this.marchMax.set(this.solidMax);

    const { trees, thins } = this.site;
    for (const tree of trees) {
      this.visitCells(tree.x - tree.radius * 1.3, tree.z - tree.radius * 1.3, tree.x + tree.radius * 1.3, tree.z + tree.radius * 1.3, (cell) => {
        if (tree.top > this.anyMax[cell]!) this.anyMax[cell] = tree.top;
        if (tree.top > this.marchMax[cell]!) this.marchMax[cell] = tree.top;
      });
    }
    [this.treeStart, this.treeItems] = this.buildIndex(this.treeCols * this.treeRows, trees.length, (index, visit) => {
      const tree = trees[index]!;
      const reach = tree.radius * 1.3;
      const c0 = clamp(Math.floor((tree.x - reach - minX) / treeCell), 0, this.treeCols - 1);
      const c1 = clamp(Math.floor((tree.x + reach - minX) / treeCell), 0, this.treeCols - 1);
      const r0 = clamp(Math.floor((tree.z - reach - minZ) / treeCell), 0, this.treeRows - 1);
      const r1 = clamp(Math.floor((tree.z + reach - minZ) / treeCell), 0, this.treeRows - 1);
      for (let row = r0; row <= r1; row += 1) for (let col = c0; col <= c1; col += 1) visit(row * this.treeCols + col);
    });
    [this.thinStart, this.thinItems] = this.buildIndex(this.coarseCols * this.coarseRows, thins.length, (index, visit) => {
      const thin = thins[index]!;
      this.visitCells(Math.min(thin.ax, thin.bx) - thin.radius, Math.min(thin.az, thin.bz) - thin.radius, Math.max(thin.ax, thin.bx) + thin.radius, Math.max(thin.az, thin.bz) + thin.radius, (cell) => {
        visit(cell);
        const top = Math.max(thin.ay, thin.by) + thin.radius;
        if (top > this.anyMax[cell]!) this.anyMax[cell] = top;
      });
    });
    for (const value of this.anyMax) if (value > this.ceiling) this.ceiling = value;
  }

  private visitCells(x0: number, z0: number, x1: number, z1: number, visit: (cell: number) => void): void {
    const c0 = clamp(Math.floor((x0 - minX) / coarseCell), 0, this.coarseCols - 1);
    const c1 = clamp(Math.floor((x1 - minX) / coarseCell), 0, this.coarseCols - 1);
    const r0 = clamp(Math.floor((z0 - minZ) / coarseCell), 0, this.coarseRows - 1);
    const r1 = clamp(Math.floor((z1 - minZ) / coarseCell), 0, this.coarseRows - 1);
    for (let row = r0; row <= r1; row += 1) for (let col = c0; col <= c1; col += 1) visit(row * this.coarseCols + col);
  }

  /** A compressed index from coarse cell to the items overlapping it. */
  private buildIndex(cells: number, count: number, cover: (index: number, visit: (cell: number) => void) => void): [Int32Array, Int32Array] {
    const start = new Int32Array(cells + 1);
    for (let index = 0; index < count; index += 1) cover(index, (cell) => (start[cell + 1] = start[cell + 1]! + 1));
    for (let cell = 0; cell < cells; cell += 1) start[cell + 1] = start[cell + 1]! + start[cell]!;
    const items = new Int32Array(start[cells]!);
    const fill = start.slice(0, cells);
    for (let index = 0; index < count; index += 1) {
      cover(index, (cell) => {
        items[fill[cell]!] = index;
        fill[cell] = fill[cell]! + 1;
      });
    }
    return [start, items];
  }

  /** How much sun reaches each spot of the surface, for the colours a camera would record. */
  private castShadows(): void {
    const trees = this.site.trees;
    for (let row = 0; row < this.shadowRows; row += 1) {
      for (let col = 0; col < this.shadowCols; col += 1) {
        const x0 = minX + col * shadowCell;
        const z0 = minZ + row * shadowCell;
        let y = this.height(x0, z0) + 0.2;
        let x = x0;
        let z = z0;
        let light = 1;
        while (light > 0.05 && y < this.ceiling) {
          const cell = this.coarseIndex(x, z);
          if (cell < 0) break;
          const low = y <= this.marchMax[cell]! + 0.5;
          const step = low ? 0.7 : 3;
          x += sunX * step;
          y += sunY * step;
          z += sunZ * step;
          if (!low) continue;
          if (y <= this.solidMax[cell]! && y < this.height(x, z)) {
            light = 0;
            break;
          }
          const crowns = this.treeIndex(x, z);
          if (crowns < 0) continue;
          for (let item = this.treeStart[crowns]!; item < this.treeStart[crowns + 1]!; item += 1) {
            const tree = trees[this.treeItems[item]!]!;
            if (insideCrown(tree, x, y, z)) light *= Math.exp(-tree.density * step * foliageClump(tree, x, y, z));
          }
        }
        this.sunlight[row * this.shadowCols + col] = Math.round(light * 255);
      }
    }
  }

  /** The surface model's height at a point, interpolated. */
  public height(x: number, z: number): number {
    const fx = clamp((x - minX) / fineCell, 0, this.fineCols - 1.001);
    const fz = clamp((z - minZ) / fineCell, 0, this.fineRows - 1.001);
    const col = Math.floor(fx);
    const row = Math.floor(fz);
    const tx = fx - col;
    const tz = fz - row;
    const i = row * this.fineCols + col;
    const j = i + this.fineCols;
    const h = this.heights;
    return (h[i]! * (1 - tx) + h[i + 1]! * tx) * (1 - tz) + (h[j]! * (1 - tx) + h[j + 1]! * tx) * tz;
  }

  /** The surface's slope at a point, from its nearest samples: east-west into `into[0]`, north-south into `into[1]`. */
  public slopeAt(x: number, z: number, into: Float64Array): void {
    const col = clamp(Math.round((x - minX) / fineCell), 1, this.fineCols - 2);
    const row = clamp(Math.round((z - minZ) / fineCell), 1, this.fineRows - 2);
    const index = row * this.fineCols + col;
    const h = this.heights;
    into[0] = (h[index + 1]! - h[index - 1]!) / (2 * fineCell);
    into[1] = (h[index + this.fineCols]! - h[index - this.fineCols]!) / (2 * fineCell);
  }

  public idAt(x: number, z: number): number {
    const col = clamp(Math.round((x - minX) / fineCell), 0, this.fineCols - 1);
    const row = clamp(Math.round((z - minZ) / fineCell), 0, this.fineRows - 1);
    return this.ids[row * this.fineCols + col]!;
  }

  public coverAt(x: number, z: number): Cover {
    const col = clamp(Math.round(x - minX), 0, this.groundCols - 1);
    const row = clamp(Math.round(z - minZ), 0, this.groundRows - 1);
    return this.cover[row * this.groundCols + col] as Cover;
  }

  public sunlightAt(x: number, z: number): number {
    const col = clamp(Math.round((x - minX) / shadowCell), 0, this.shadowCols - 1);
    const row = clamp(Math.round((z - minZ) / shadowCell), 0, this.shadowRows - 1);
    return this.sunlight[row * this.shadowCols + col]! / 255;
  }

  /** The crown-index cell a point falls in, or -1 outside the site. */
  public treeIndex(x: number, z: number): number {
    const col = Math.floor((x - minX) / treeCell);
    const row = Math.floor((z - minZ) / treeCell);
    if (col < 0 || row < 0 || col >= this.treeCols || row >= this.treeRows) return -1;
    return row * this.treeCols + col;
  }

  public coarseIndex(x: number, z: number): number {
    const col = Math.floor((x - minX) / coarseCell);
    const row = Math.floor((z - minZ) / coarseCell);
    if (col < 0 || row < 0 || col >= this.coarseCols || row >= this.coarseRows) return -1;
    return row * this.coarseCols + col;
  }
}

/** Growable per-point channels. */
class PointSink {
  public count = 0;
  public positions = new Float32Array(0);
  public colors = new Uint8Array(0);
  public intensity = new Float32Array(0);
  public returnNumber = new Uint8Array(0);
  public numberOfReturns = new Uint8Array(0);

  public constructor(capacity: number) {
    this.grow(Math.max(16, capacity));
  }

  public push(x: number, y: number, z: number, colour: Rgb, shade: number, intensity: number, returnNumber: number, numberOfReturns: number, random: Random): void {
    if (this.count === this.intensity.length) this.grow(this.count * 2);
    const offset = this.count * 3;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = z;
    this.colors[offset] = clampByte(colour.r * shade + (random() - 0.5) * 10);
    this.colors[offset + 1] = clampByte(colour.g * shade + (random() - 0.5) * 10);
    this.colors[offset + 2] = clampByte(colour.b * shade + (random() - 0.5) * 10);
    this.intensity[this.count] = intensity;
    this.returnNumber[this.count] = returnNumber;
    this.numberOfReturns[this.count] = numberOfReturns;
    this.count += 1;
  }

  private grow(capacity: number): void {
    const positions = new Float32Array(capacity * 3);
    positions.set(this.positions);
    this.positions = positions;
    const colors = new Uint8Array(capacity * 3);
    colors.set(this.colors);
    this.colors = colors;
    const intensity = new Float32Array(capacity);
    intensity.set(this.intensity);
    this.intensity = intensity;
    const returnNumber = new Uint8Array(capacity);
    returnNumber.set(this.returnNumber);
    this.returnNumber = returnNumber;
    const numberOfReturns = new Uint8Array(capacity);
    numberOfReturns.set(this.numberOfReturns);
    this.numberOfReturns = numberOfReturns;
  }
}

const enumKind = { ground: 0, block: 1, pile: 2, tree: 4, thin: 5 } as const;

/** Traces pulses through a {@link SiteModel} and writes their returns. */
class Scanner {
  private readonly echoT = new Float64Array(8);
  private readonly echoKind = new Int32Array(8);
  private readonly echoItem = new Int32Array(8);
  private readonly echoEnergy = new Float64Array(8);
  private readonly order = new Int32Array(8);
  private readonly slope = new Float64Array(2);
  private echoCount = 0;
  private stripDx = 0;
  private stripDy = 0;

  public constructor(
    private readonly model: SiteModel,
    private readonly random: Random,
    private readonly sink: PointSink | undefined,
  ) {}

  public setStripError(dx: number, dy: number): void {
    this.stripDx = dx;
    this.stripDy = dy;
  }

  /** Traces one pulse; returns how many returns inside the survey area it produced. */
  public pulse(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const model = this.model;
    const random = this.random;
    this.echoCount = 0;
    let energy = 1;
    let lastEcho = Number.NEGATIVE_INFINITY;

    // Start where the pulse comes down past the tallest thing on the site.
    let t = Math.max(0, (oy - model.ceiling) / -dy);
    let x = ox + dx * t;
    let z = oz + dz * t;
    let col = Math.floor((x - minX) / coarseCell);
    let row = Math.floor((z - minZ) / coarseCell);
    const stepCol = dx > 0 ? 1 : -1;
    const stepRow = dz > 0 ? 1 : -1;
    const deltaCol = Math.abs(coarseCell / (dx || 1e-9));
    const deltaRow = Math.abs(coarseCell / (dz || 1e-9));
    let nextCol = t + ((minX + (col + (dx > 0 ? 1 : 0)) * coarseCell - x) / (dx || 1e-9));
    let nextRow = t + ((minZ + (row + (dz > 0 ? 1 : 0)) * coarseCell - z) / (dz || 1e-9));
    if (!Number.isFinite(nextCol) || nextCol < t) nextCol = Number.POSITIVE_INFINITY;
    if (!Number.isFinite(nextRow) || nextRow < t) nextRow = Number.POSITIVE_INFINITY;

    // Fine steps near the surface, where walls and slopes need them; coarser ones through open canopy.
    const nearStep = 0.45;
    const canopyStep = 0.8;
    let solidT = Number.NaN;
    let solidKind = 0;
    let solidItem = 0;

    march: while (col >= 0 && row >= 0 && col < model.coarseCols && row < model.coarseRows) {
      const cell = row * model.coarseCols + col;
      const exit = Math.min(nextCol, nextRow);
      const exitY = oy + dy * exit;
      const ceiling = model.anyMax[cell]!;
      if (exitY <= ceiling) {
        // Thin structures: tested analytically, since a step could jump right over a conductor.
        const thins = model.site.thins;
        for (let item = model.thinStart[cell]!; item < model.thinStart[cell + 1]!; item += 1) {
          const index = model.thinItems[item]!;
          const hit = rayToSegment(ox, oy, oz, dx, dy, dz, thins[index]!);
          if (hit >= t - 1e-6 && hit < exit && random() < 0.85) this.addEcho(hit, enumKind.thin, index, energy * 0.6);
        }

        const trees = model.site.trees;
        const solidTop = model.solidMax[cell]!;
        let s = Math.max(t, (oy - model.marchMax[cell]!) / -dy);
        let previous = s;
        while (s <= exit) {
          const px = ox + dx * s;
          const py = oy + dy * s;
          const pz = oz + dz * s;
          if (py <= solidTop) {
            const surface = model.height(px, pz);
            if (py <= surface) {
              // Home in on where the pulse met the surface.
              let low = previous;
              let high = s;
              for (let iteration = 0; iteration < 5; iteration += 1) {
                const mid = (low + high) / 2;
                if (oy + dy * mid <= model.height(ox + dx * mid, oz + dz * mid)) high = mid;
                else low = mid;
              }
              solidT = high;
              const id = model.idAt(ox + dx * high, oz + dz * high);
              const blocks = model.site.blocks.length;
              solidKind = id === 0 ? enumKind.ground : id <= blocks ? enumKind.block : enumKind.pile;
              solidItem = id === 0 ? 0 : id <= blocks ? id - 1 : id - blocks - 1;
              break march;
            }
          }
          const crowns = energy > 0.15 && py <= model.marchMax[cell]! ? model.treeIndex(px, pz) : -1;
          const step = py <= solidTop + 1 ? nearStep : canopyStep;
          if (crowns >= 0) {
            for (let item = model.treeStart[crowns]!; item < model.treeStart[crowns + 1]!; item += 1) {
              const index = model.treeItems[item]!;
              const tree = trees[index]!;
              if (py > tree.top || py < tree.crownBase || !insideCrown(tree, px, py, pz)) continue;
              const chance = 1 - Math.exp(-tree.density * step * foliageClump(tree, px, py, pz));
              if (s - lastEcho > deadZone && random() < chance) {
                this.addEcho(s - random() * step, enumKind.tree, index, energy);
                lastEcho = s;
                energy *= 0.55;
              }
            }
          }
          previous = s;
          s += step;
        }
      }
      t = exit;
      if (nextCol < nextRow) {
        col += stepCol;
        nextCol += deltaCol;
      } else {
        row += stepRow;
        nextRow += deltaRow;
      }
    }

    if (!Number.isNaN(solidT) && energy > 0.08) this.addEcho(solidT, solidKind, solidItem, energy);
    return this.emit(ox, oy, oz, dx, dy, dz, solidT);
  }

  private addEcho(t: number, kind: number, item: number, energy: number): void {
    const index = this.echoCount;
    if (index >= this.echoT.length) return;
    this.echoT[index] = t;
    this.echoKind[index] = kind;
    this.echoItem[index] = item;
    this.echoEnergy[index] = energy;
    this.echoCount = index + 1;
  }

  private emit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, solidT: number): number {
    // Order the echoes along the pulse, drop any behind the surface, and merge
    // those closer together than the receiver can separate.
    const echoT = this.echoT;
    const order = this.order;
    let count = 0;
    for (let index = 0; index < this.echoCount; index += 1) {
      if (!Number.isNaN(solidT) && echoT[index]! > solidT + 1e-6) continue;
      let at = count;
      while (at > 0 && echoT[order[at - 1]!]! > echoT[index]!) {
        order[at] = order[at - 1]!;
        at -= 1;
      }
      order[at] = index;
      count += 1;
    }
    let total = 0;
    for (let index = 0; index < count && total < maxReturns; index += 1) {
      const echo = order[index]!;
      if (total > 0 && echoT[echo]! - echoT[order[total - 1]!]! < deadZone) continue;
      order[total] = echo;
      total += 1;
    }

    let written = 0;
    const random = this.random;
    const model = this.model;
    const sink = this.sink;
    for (let index = 0; index < total; index += 1) {
      const echo = order[index]!;
      const kind = this.echoKind[echo]!;
      const item = this.echoItem[echo]!;
      // Range noise: roughly normal, with a spread of about two centimetres.
      const range = echoT[echo]! + (random() + random() + random() - 1.5) * 0.036;
      const x = ox + dx * range + this.stripDx;
      let y = oy + dy * range + this.stripDy;
      const z = oz + dz * range;
      if (Math.abs(x) > halfWidth || Math.abs(z) > halfDepth) continue;

      let colour: Rgb;
      let shade = 1;
      let reflectance: number;
      let incidence = 1;

      if (kind === enumKind.ground || kind === enumKind.block || kind === enumKind.pile) {
        model.slopeAt(x, z, this.slope);
        const gx = this.slope[0]!;
        const gz = this.slope[1]!;
        const norm = Math.hypot(gx, 1, gz);
        const light = 0.5 + 0.55 * Math.max(0, (-gx * sunX + sunY - gz * sunZ) / norm);
        incidence = Math.abs(-gx * dx + dy - gz * dz) / norm;
        shade = light * (0.55 + 0.45 * model.sunlightAt(x, z));
        if (kind === enumKind.ground) {
          const cover = model.coverAt(x, z);
          const surface = surfaceAt(cover, x, z, Math.hypot(gx, gz));
          if (cover === Cover.Water) {
            // Water sends a pulse on, not back - except now and then, straight down.
            if (random() > 0.05 * Math.max(0, -dy - 0.97) * 33) continue;
          }
          colour = surface.colour;
          reflectance = surface.reflectance;
          if (surface.lowVegetation > 0 && index === total - 1) y += surface.lowVegetation * Math.pow(random(), 0.7);
        } else if (kind === enumKind.block) {
          const b = model.site.blocks[item]!;
          const wall = y < blockTopAt(b, x, z) - 0.35;
          colour = wall ? b.wallColour : b.roofColour;
          reflectance = wall ? b.wallReflectance : b.roofReflectance;
        } else if (kind === enumKind.pile) {
          const p = model.site.piles[item]!;
          colour = p.colour;
          reflectance = p.reflectance;
          shade *= 0.92 + 0.16 * hash(Math.floor(y * 3), item, 7);
        } else {
          colour = bark;
          reflectance = 0.3;
        }
      } else if (kind === enumKind.tree) {
        const tree = model.site.trees[item]!;
        const height = (y - tree.crownBase) / Math.max(0.5, tree.top - tree.crownBase);
        const sunSide = Math.max(0, ((x - tree.x) * sunX + (z - tree.z) * sunZ) / Math.max(0.5, tree.radius));
        colour = tree.colour;
        shade = (0.5 + 0.55 * clamp(height, 0, 1)) * (0.85 + 0.25 * sunSide) * (0.9 + 0.2 * hash(Math.floor(x * 2), Math.floor(z * 2), tree.seed));
        reflectance = 0.5;
        incidence = 0.6 + 0.4 * random();
      } else {
        const thin = model.site.thins[item]!;
        colour = thin.colour;
        shade = 0.85 + 0.2 * random();
        reflectance = thin.reflectance;
        incidence = 0.7;
      }

      // Intensity falls off with range and a grazing angle, and is shared between returns.
      const rangeFactor = clamp((80 / Math.max(20, range)) ** 2, 0.4, 2);
      const intensity = clamp(reflectance * Math.pow(Math.max(0.05, incidence), 0.7) * rangeFactor * Math.sqrt(this.echoEnergy[echo]!) * 52_000 * (0.94 + random() * 0.12), 0, 65_535);
      if (sink !== undefined) sink.push(x, y, z, colour, shade, Math.round(intensity), index + 1, total, random);
      written += 1;
    }
    return written;
  }
}

function blockTopAt(b: Block, x: number, z: number): number {
  const dx = x - b.x;
  const dz = z - b.z;
  const u = clamp(dx * b.cos + dz * b.sin, -b.halfX, b.halfX);
  const v = clamp(-dx * b.sin + dz * b.cos, -b.halfZ, b.halfZ);
  return blockTop(b, b.round ? u * 0.99 : u, b.round ? v * 0.99 : v);
}

/** Distance along a ray at which it passes within a thin structure's radius, or NaN. */
function rayToSegment(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, thin: Thin): number {
  const ux = thin.bx - thin.ax;
  const uy = thin.by - thin.ay;
  const uz = thin.bz - thin.az;
  const wx = ox - thin.ax;
  const wy = oy - thin.ay;
  const wz = oz - thin.az;
  const a = dx * dx + dy * dy + dz * dz;
  const b = dx * ux + dy * uy + dz * uz;
  const c = ux * ux + uy * uy + uz * uz;
  const d = dx * wx + dy * wy + dz * wz;
  const e = ux * wx + uy * wy + uz * wz;
  const denominator = a * c - b * b;
  let s = denominator > 1e-9 ? (b * e - c * d) / denominator : 0;
  let u = c > 0 ? (e + b * s) / c : 0;
  u = clamp(u, 0, 1);
  s = (b * u - d) / a;
  const px = ox + dx * s - (thin.ax + ux * u);
  const py = oy + dy * s - (thin.ay + uy * u);
  const pz = oz + dz * s - (thin.az + uz * u);
  return px * px + py * py + pz * pz <= thin.radius * thin.radius ? s : Number.NaN;
}

export interface SimulatedSurvey {
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly intensity: Float32Array;
  readonly returnNumber: Uint8Array;
  readonly numberOfReturns: Uint8Array;
  readonly pointCount: number;
}

interface Flight {
  readonly altitude: number;
  readonly linesPerStrip: number;
  readonly pulsesPerLine: number;
}

/** Flies the mission, calling `pulse` for every shot the scanner fires, in order. */
function fly(flight: Flight, random: Random, scanner: Scanner, onStrip?: (strip: number) => void): void {
  const { altitude, linesPerStrip, pulsesPerLine } = flight;
  const start = -halfWidth - runIn;
  const length = (halfWidth + runIn) * 2;
  const spacing = length / linesPerStrip;
  stripZs.forEach((stripZ, strip) => {
    const heading = strip % 2 === 0 ? 1 : -1;
    // Each strip sits a couple of centimetres off the others: boresight and trajectory error.
    scanner.setStripError(gaussian(random) * 0.03, gaussian(random) * 0.025);
    for (let line = 0; line < linesPerStrip; line += 1) {
      const along = start + (heading > 0 ? line : linesPerStrip - 1 - line) * spacing;
      const roll = 0.012 * Math.sin(line * 0.021 + strip * 1.7) + 0.004 * Math.sin(line * 0.13 + strip);
      const pitch = 0.01 * Math.sin(line * 0.017 + strip * 0.9);
      const oy = altitude + 0.6 * Math.sin(line * 0.006 + strip);
      const oz = stripZ + 1.2 * Math.sin(line * 0.004 + strip * 2.3);
      for (let pulse = 0; pulse < pulsesPerLine; pulse += 1) {
        const sweep = -halfFieldOfView + (2 * halfFieldOfView * (pulse + 0.5)) / pulsesPerLine + roll;
        // The aircraft keeps moving while the mirror sweeps, so each line runs slightly diagonal.
        const ox = along + heading * spacing * (pulse / pulsesPerLine);
        const dx = Math.sin(pitch) * heading;
        const dy = -Math.cos(sweep) * Math.cos(pitch);
        const dz = Math.sin(sweep);
        scanner.pulse(ox, oy, oz, dx, dy, dz);
      }
    }
    onStrip?.(strip + 1);
  });
}

/**
 * Simulates the survey, aiming for about `targetPoints` returns: a short trial
 * flight measures how many returns a pulse yields over this site, and the
 * scan rate is set from that.
 */
export function simulateSurvey(targetPoints: number, random: Random, onProgress?: (fraction: number) => void): SimulatedSurvey {
  const site = buildSite(random);
  const model = new SiteModel(site);
  onProgress?.(0.15);
  const altitude = model.highestGround + 46;

  // A trial: random pulses across the mission, counting returns per pulse.
  const trial = new Scanner(model, random, undefined);
  let trialReturns = 0;
  const trialPulses = 3000;
  for (let index = 0; index < trialPulses; index += 1) {
    const stripZ = stripZs[Math.floor(random() * stripZs.length)]!;
    const sweep = -halfFieldOfView + 2 * halfFieldOfView * random();
    trialReturns += trial.pulse(-halfWidth - runIn + random() * (halfWidth + runIn) * 2, altitude, stripZ, 0, -Math.cos(sweep), Math.sin(sweep));
  }
  const returnsPerPulse = Math.max(0.2, trialReturns / trialPulses);
  const pulses = (targetPoints / returnsPerPulse) * 1.04;
  // Lines as far apart along the track as pulses are across it, at the typical height above ground.
  const swathPerLine = (2 * (altitude - 40) * Math.tan(halfFieldOfView)) / 1;
  const trackLength = (halfWidth + runIn) * 2 * stripZs.length;
  const pulsesPerLine = Math.max(2, Math.round(Math.sqrt((pulses * swathPerLine) / trackLength)));
  const linesPerStrip = Math.max(1, Math.round(pulses / (pulsesPerLine * stripZs.length)));

  const sink = new PointSink(Math.ceil(targetPoints * 1.1));
  const scanner = new Scanner(model, random, sink);
  fly({ altitude, linesPerStrip, pulsesPerLine }, random, scanner, (strip) => onProgress?.(0.15 + (0.8 * strip) / stripZs.length));

  // A real capture also holds a few strays: birds above the site and multipath below the ground.
  const strays = Math.round(targetPoints * 0.00004);
  for (let index = 0; index < strays * 2; index += 1) {
    const x = (random() - 0.5) * 2 * (halfWidth - 1);
    const z = (random() - 0.5) * 2 * (halfDepth - 1);
    const ground = model.height(x, z);
    const y = index < strays ? ground + 25 + random() * 40 : ground - 1 - random() * 4;
    sink.push(x, y, z, { r: 90, g: 90, b: 90 }, 1, 2000 + random() * 4000, 1, 1, random);
  }

  return trimTo(sink, targetPoints);
}

/** Thins the capture evenly to exactly `target` points, if it overshot. */
function trimTo(sink: PointSink, target: number): SimulatedSurvey {
  const count = sink.count;
  if (count <= target) {
    return {
      positions: sink.positions.slice(0, count * 3),
      colors: sink.colors.slice(0, count * 3),
      intensity: sink.intensity.slice(0, count),
      returnNumber: sink.returnNumber.slice(0, count),
      numberOfReturns: sink.numberOfReturns.slice(0, count),
      pointCount: count,
    };
  }
  const positions = new Float32Array(target * 3);
  const colors = new Uint8Array(target * 3);
  const intensity = new Float32Array(target);
  const returnNumber = new Uint8Array(target);
  const numberOfReturns = new Uint8Array(target);
  let kept = 0;
  for (let index = 0; index < count && kept < target; index += 1) {
    // Keep a point whenever the running share of kept points falls behind.
    if (Math.floor(((index + 1) * target) / count) === kept) continue;
    const from = index * 3;
    const to = kept * 3;
    positions[to] = sink.positions[from]!;
    positions[to + 1] = sink.positions[from + 1]!;
    positions[to + 2] = sink.positions[from + 2]!;
    colors[to] = sink.colors[from]!;
    colors[to + 1] = sink.colors[from + 1]!;
    colors[to + 2] = sink.colors[from + 2]!;
    intensity[kept] = sink.intensity[index]!;
    returnNumber[kept] = sink.returnNumber[index]!;
    numberOfReturns[kept] = sink.numberOfReturns[index]!;
    kept += 1;
  }
  return { positions, colors, intensity, returnNumber, numberOfReturns, pointCount: kept };
}

