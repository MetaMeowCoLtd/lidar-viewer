import {
  acrossRiver,
  bankOuter,
  bridgeEastX,
  bridgeHalfWidth,
  bridgeWestX,
  bridgeZ,
  carPark,
  churchPlaza,
  forestAt,
  groundSurface,
  inWater,
  lowestGround,
  powerLineZ,
  pylonXs,
  riverAngle,
  riverDistance,
  riverX,
  roadClearance,
  roads,
  sceneHalfDepth,
  sidewalkWidth,
  solarFarm,
  stadium,
  terrainHeight,
  turbines,
  underBridge,
  waterLevel,
  zoneAt,
} from "./landscape.js";
import { jitter, pick, rgb, smoothstep, sunShade, type Random, type Rgb, type Surface, type Vec3 } from "./sampling.js";
import {
  FootprintIndex,
  buildingSurfaces,
  curveSurface,
  lineSurface,
  makeBuilding,
  makeTree,
  stack,
  top,
  treeSurface,
  wireSurface,
  type Building,
  type BuildingSpec,
} from "./structures.js";

const walls = {
  render: rgb(226, 220, 206),
  cream: rgb(216, 198, 160),
  brick: rgb(156, 78, 58),
  stone: rgb(176, 170, 160),
  blue: rgb(162, 182, 198),
  ochre: rgb(204, 158, 98),
  sandstone: rgb(204, 182, 144),
  timber: rgb(122, 86, 60),
  concrete: rgb(156, 158, 160),
  steel: rgb(186, 190, 194),
};

const roofs = {
  terracotta: rgb(168, 82, 58),
  slate: rgb(74, 78, 90),
  brownTile: rgb(122, 76, 54),
  membrane: rgb(98, 98, 102),
  gravel: rgb(136, 132, 124),
  copper: rgb(94, 152, 128),
  metal: rgb(156, 160, 164),
  white: rgb(228, 228, 224),
};

const paints = [rgb(184, 188, 194), rgb(38, 40, 46), rgb(228, 228, 224), rgb(176, 44, 40), rgb(44, 86, 150), rgb(86, 90, 96), rgb(40, 110, 90)];

const junctions: ReadonlyArray<readonly [number, number]> = [
  [-70, 0],
  [-70, -85],
  [-70, 95],
  [bridgeEastX, 0],
];

/** Collects everything the scene is made of while it is laid out. */
class Scene {
  public readonly surfaces: Surface[] = [];
  public readonly footprints = new FootprintIndex();

  public constructor(public readonly random: Random) {}

  /** A building standing on the ground: it hides the ground beneath it. */
  public build(spec: BuildingSpec): Building {
    const building = makeBuilding(spec);
    this.footprints.add(building);
    this.surfaces.push(...buildingSurfaces(building));
    return building;
  }

  /** Something standing on top of something else, or floating on water. */
  public place(building: Building): Building {
    this.surfaces.push(...buildingSurfaces(building));
    return building;
  }

  public add(...surfaces: Surface[]): void {
    this.surfaces.push(...surfaces);
  }

  /** Whether a footprint of the given half-size and angle is clear of roads, water, fields and other buildings. */
  public canBuild(x: number, z: number, hw: number, hd: number, angle: number, clearance = sidewalkWidth + 2): boolean {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const points: Array<readonly [number, number]> = [[x, z]];
    for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const u = su * (hw + 1);
      const v = sv * (hd + 1);
      points.push([x + u * cos - v * sin, z + u * sin + v * cos]);
    }
    return points.every(
      ([px, pz]) =>
        Math.abs(riverDistance(px, pz)) > bankOuter + 2 &&
        roadClearance(px, pz) > clearance &&
        zoneAt(px, pz) === "none" &&
        !underBridge(px, pz) &&
        !this.footprints.covers(px, pz, 2.5),
    );
  }

  public canPlant(x: number, z: number, radius: number, options: { street?: boolean; anyZone?: boolean } = {}): boolean {
    if (inWater(x, z) || Math.abs(riverDistance(x, z)) < 12 || underBridge(x, z)) return false;
    if (!options.street && roadClearance(x, z) < 1.2 + radius * 0.5) return false;
    if (!options.anyZone && zoneAt(x, z) !== "none") return false;
    if (Math.abs(riverDistance(x, z) + 17) < 1.8) return false;
    return !this.footprints.covers(x, z, radius * 0.7 + 0.4);
  }

  public plant(x: number, z: number, conifer: boolean, scale = 1, options: { street?: boolean; anyZone?: boolean } = {}): boolean {
    const tree = makeTree(this.random, x, z, terrainHeight(x, z) - 0.1, conifer, scale);
    if (!this.canPlant(x, z, tree.radius, options)) return false;
    this.surfaces.push(treeSurface(tree));
    return true;
  }
}

/**
 * Lays out the whole sample: the ground, the town on the west bank, the
 * bridge, the forested hill with its turbines, the power line, the fields
 * and the solar farm. Landmarks are placed by hand so the scene always
 * frames well; houses, cars and trees are scattered by `random`, so every
 * seed gives a slightly different town.
 */
export function buildTown(random: Random): Surface[] {
  const scene = new Scene(random);

  downtown(scene);
  church(scene);
  courtyardAndFactory(scene);
  sports(scene);
  schoolAndCarPark(scene);
  houses(scene);
  bridge(scene);
  riverside(scene);
  traffic(scene);
  streetFurniture(scene);
  powerLine(scene);
  turbines.forEach((turbine, index) => windTurbine(scene, turbine.x, turbine.z, Math.PI + index * 0.25, 0.4 + index * 0.9));
  solarPanels(scene);
  trees(scene);

  scene.add(groundSurface((x, z) => scene.footprints.covers(x, z)));
  return scene.surfaces;
}

// ------------------------------------------------------------------ town

function rooftopPlant(scene: Scene, roof: Building, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const hw = 1.2 + scene.random() * 1.6;
    const hd = 1 + scene.random() * 1.2;
    const u = jitter(scene.random, Math.max(0, (roof.hw - hw - 1.5) * 2));
    const v = jitter(scene.random, Math.max(0, (roof.hd - hd - 1.5) * 2));
    const x = roof.cx + u * roof.cos - v * roof.sin;
    const z = roof.cz + u * roof.sin + v * roof.cos;
    if (roof.holes.some((hole) => Math.hypot(hole.cx - x, hole.cz - z) < hole.hw + hw + 1)) continue;
    scene.place(stack(roof, { x, z, angle: Math.atan2(roof.sin, roof.cos), halfWidth: hw, halfDepth: hd, height: 1.4 + scene.random() * 1.2, wall: walls.steel, roofColour: rgb(166, 170, 172) }));
  }
}

function downtown(scene: Scene): void {
  // A glass tower with a plant-room crown and a mast.
  const glass = scene.build({ x: -178, z: -134, halfWidth: 13, halfDepth: 12, height: 58, glass: 0.85, glassColour: rgb(46, 82, 112), wall: walls.steel, roofColour: roofs.membrane, parapet: 1.2 });
  const crown = scene.place(stack(glass, { x: -178, z: -134, halfWidth: 8, halfDepth: 7, height: 5, wall: walls.concrete, roofColour: roofs.gravel }));
  scene.add(lineSurface([-178, top(crown), -134], [-178, top(crown) + 14, -134], 0.15, walls.steel, 2));
  rooftopPlant(scene, glass, 5);

  // A stepped tower in sandstone, with a copper pyramid on top.
  const podium = scene.build({ x: -138, z: -130, halfWidth: 16, halfDepth: 13, height: 22, glass: 0.32, wall: walls.sandstone, roofColour: roofs.gravel, parapet: 0.9 });
  const middle = scene.place(stack(podium, { x: -138, z: -130, halfWidth: 11, halfDepth: 9, height: 16, glass: 0.32, wall: walls.sandstone, roofColour: roofs.gravel, parapet: 0.9 }));
  scene.place(stack(middle, { x: -138, z: -130, halfWidth: 6, halfDepth: 6, height: 11, glass: 0.32, wall: walls.sandstone, roofColour: roofs.copper, roof: "pyramid", ridge: 7 }));
  rooftopPlant(scene, podium, 4);

  // A round tower, glazed all the way up, under a shallow dome.
  scene.build({ x: -104, z: -140, halfWidth: 11, round: true, height: 44, glass: 0.8, glassColour: rgb(56, 98, 104), wall: walls.steel, roofColour: roofs.white, roof: "dome", ridge: 4 });

  // Mid-rise offices along the north street.
  const offices = [
    { x: -198, z: -104, halfWidth: 11, halfDepth: 6.5, height: 18, wall: walls.concrete },
    { x: -158, z: -102, halfWidth: 12, halfDepth: 6, height: 14, wall: walls.brick },
    { x: -108, z: -104, halfWidth: 13, halfDepth: 6.5, height: 22, wall: walls.blue },
  ];
  for (const office of offices) {
    const building = scene.build({ ...office, glass: 0.36, roofColour: roofs.membrane, parapet: 0.8 });
    rooftopPlant(scene, building, 3);
  }
}

function church(scene: Scene): void {
  const nave = { x: -38, z: -122, angle: Math.PI / 2, halfWidth: 15, halfDepth: 6.5 };
  scene.build({ ...nave, height: 11, roof: "gable", ridge: 7, glass: 0.18, glassColour: rgb(86, 72, 118), wall: walls.stone, roofColour: roofs.slate });
  // The transept crosses the nave near its east end.
  scene.build({ x: -38, z: -114, halfWidth: 11, halfDepth: 5, height: 10, roof: "gable", ridge: 6, glass: 0.18, glassColour: rgb(86, 72, 118), wall: walls.stone, roofColour: roofs.slate });
  const tower = scene.build({ x: -38, z: -142, halfWidth: 4.2, height: 27, glass: 0.1, wall: walls.stone, roofColour: roofs.copper, roof: "pyramid", ridge: 17 });
  scene.add(lineSurface([-38, top(tower) + 17, -142], [-38, top(tower) + 20, -142], 0.12, rgb(210, 180, 90), 3));

  for (let z = churchPlaza.minZ + 4; z < churchPlaza.maxZ; z += 11) {
    scene.plant(churchPlaza.minX + 2.5, z, false, 0.75, { anyZone: true });
    scene.plant(churchPlaza.maxX - 2.5, z + 5, false, 0.75, { anyZone: true });
  }
}

function courtyardAndFactory(scene: Scene): void {
  // A perimeter block around a garden courtyard.
  const block = { wall: walls.ochre, roofColour: roofs.terracotta, height: 16, roof: "gable" as const, ridge: 4, glass: 0.32 };
  scene.build({ ...block, x: -180, z: -59, halfWidth: 22, halfDepth: 5 });
  scene.build({ ...block, x: -180, z: -25, halfWidth: 22, halfDepth: 5 });
  scene.build({ ...block, x: -197, z: -42, angle: Math.PI / 2, halfWidth: 12, halfDepth: 5 });
  scene.build({ ...block, x: -163, z: -42, angle: Math.PI / 2, halfWidth: 12, halfDepth: 5 });
  scene.plant(-184, -44, false, 1.1);
  scene.plant(-175, -38, false, 0.9);

  // A factory with a sawtooth roof, and its chimney.
  scene.build({ x: -114, z: -44, halfWidth: 24, halfDepth: 14, height: 9, roof: "sawtooth", ridge: 3, wall: walls.concrete, roofColour: roofs.metal });
  scene.build({ x: -130, z: -69, halfWidth: 1.8, round: true, height: 36, wall: walls.brick, roofColour: rgb(40, 38, 36) });
}

function sports(scene: Scene): void {
  const seats = (v: number, hd: number): Rgb => (Math.floor((v + hd) / 0.9) % 2 === 0 ? rgb(46, 84, 164) : rgb(34, 62, 128));
  // The main stand rises away from the pitch; `angle` turns its high side to the north.
  scene.build({ x: stadium.x, z: 17, angle: Math.PI, halfWidth: 32, halfDepth: 4.5, height: 2.5, roof: "shed", ridge: 9, wall: walls.concrete, roofColour: roofs.white, roofPaint: (_u, v) => seats(v, 4.5) });
  scene.build({ x: stadium.x, z: 86, halfWidth: 24, halfDepth: 3.5, height: 2, roof: "shed", ridge: 6, wall: walls.concrete, roofColour: roofs.white, roofPaint: (_u, v) => seats(v, 3.5) });

  for (const [x, z] of [[stadium.x - 60, 25], [stadium.x + 60, 25], [stadium.x - 60, 79], [stadium.x + 60, 79]] as const) {
    const ground = terrainHeight(x, z);
    scene.add(lineSurface([x, ground, z], [x, ground + 30, z], 0.2, walls.steel, 2));
    scene.place(makeBuilding({ x, z, angle: Math.atan2(stadium.z - z, stadium.x - x) + Math.PI / 2, halfWidth: 2.2, halfDepth: 0.6, base: ground + 30, height: 1.8, wall: rgb(236, 236, 226), roofColour: walls.steel }));
  }
  for (let t = 0; t < 1; t += 1 / 26) {
    const [x, z] = aroundStadium(t, stadium.apron + 4);
    scene.plant(x + jitter(scene.random, 2), z + jitter(scene.random, 2), false, 0.9);
  }
}

/** A point on the rounded rectangle `radius` out from the stadium's straights, `t` of the way round. */
function aroundStadium(t: number, radius: number): [number, number] {
  const straight = stadium.straight * 2;
  const bend = Math.PI * radius;
  let d = t * (2 * straight + 2 * bend);
  if (d < straight) return [stadium.x - stadium.straight + d, stadium.z - radius];
  d -= straight;
  if (d < bend) {
    const angle = -Math.PI / 2 + d / radius;
    return [stadium.x + stadium.straight + Math.cos(angle) * radius, stadium.z + Math.sin(angle) * radius];
  }
  d -= bend;
  if (d < straight) return [stadium.x + stadium.straight - d, stadium.z + radius];
  d -= straight;
  const angle = Math.PI / 2 + d / radius;
  return [stadium.x - stadium.straight + Math.cos(angle) * radius, stadium.z + Math.sin(angle) * radius];
}

function solarRoof(hw: number, hd: number, base: Rgb): (u: number, v: number) => Rgb {
  return (u, v) => {
    if (Math.abs(u) > hw - 1.5 || Math.abs(v) > hd - 1.5) return base;
    if (((v + hd) % 2.3) > 1.7) return base;
    return ((u + 40) % 1.05) < 0.07 ? rgb(118, 128, 146) : rgb(30, 44, 84);
  };
}

function schoolAndCarPark(scene: Scene): void {
  const school = { wall: walls.cream, roofColour: roofs.gravel, height: 11, glass: 0.36, parapet: 0.8 };
  scene.build({ ...school, x: -35, z: 64, halfWidth: 20, halfDepth: 6.5, roofPaint: solarRoof(20, 6.5, roofs.gravel) });
  scene.build({ ...school, x: -48.5, z: 79, angle: Math.PI / 2, halfWidth: 9, halfDepth: 6.5, roofPaint: solarRoof(9, 6.5, roofs.gravel) });

  for (const rowCentre of [4.5, 9.5, 20.5, 25.5]) {
    for (let x = carPark.minX + 1.3; x < carPark.maxX - 1; x += 2.6) {
      if (scene.random() < 0.72) car(scene, x, carPark.minZ + rowCentre, Math.PI / 2 + (scene.random() < 0.5 ? 0 : Math.PI));
    }
  }
}

const houseWalls = [walls.render, walls.render, walls.cream, walls.brick, walls.stone, walls.blue];
const houseRoofs = [roofs.terracotta, roofs.terracotta, roofs.slate, roofs.brownTile];

function houses(scene: Scene): void {
  const random = scene.random;
  // Terraces of houses on the town's side of the river, turned to face it where they are close to it.
  const areas = [
    { minX: -58, maxX: 30, minZ: -80, maxZ: -8, style: "town" },
    { minX: -8, maxX: 60, minZ: 8, maxZ: 92, style: "town" },
    { minX: -58, maxX: 30, minZ: -168, maxZ: -90, style: "town" },
    { minX: 84, maxX: 150, minZ: -60, maxZ: 60, style: "chalet" },
  ] as const;
  for (const area of areas) {
    for (let z = area.minZ + 7; z < area.maxZ; z += 15) {
      for (let x = area.minX + 7; x < area.maxX; x += 17) {
        const px = x + jitter(random, 4);
        const pz = z + jitter(random, 3);
        const chalet = area.style === "chalet";
        const nearRiver = riverDistance(px, pz) > -60;
        const angle = (nearRiver ? riverAngle(pz) : 0) + (random() < 0.3 ? Math.PI / 2 : 0) + jitter(random, 0.06);
        const hw = 4.6 + random() * 2;
        const hd = 3.6 + random() * 1.2;
        if (!scene.canBuild(px, pz, hw, hd, angle)) continue;
        scene.build({
          x: px,
          z: pz,
          angle,
          halfWidth: hw,
          halfDepth: hd,
          height: chalet ? 4.2 + random() : 5.4 + random() * 1.6,
          roof: chalet || random() < 0.6 ? "gable" : "hip",
          ridge: chalet ? 4 + random() : 2.6 + random(),
          glass: 0.26,
          wall: chalet ? walls.timber : pick(random, houseWalls),
          roofColour: chalet ? roofs.slate : pick(random, houseRoofs),
        });
        // A garden tree or two, and sometimes a car in the drive.
        for (let index = 0; index < 1 + Math.floor(random() * 2); index += 1) {
          const angleOut = random() * Math.PI * 2;
          scene.plant(px + Math.cos(angleOut) * (hw + 4), pz + Math.sin(angleOut) * (hw + 4), chalet || random() < 0.15, 0.8);
        }
        if (random() < 0.35) {
          const side = random() < 0.5 ? -1 : 1;
          const cx = px - Math.sin(angle) * side * (hd + 3.2);
          const cz = pz + Math.cos(angle) * side * (hd + 3.2);
          if (roadClearance(cx, cz) > 0.5 && !scene.footprints.covers(cx, cz, 1.5) && Math.abs(riverDistance(cx, cz)) > bankOuter) car(scene, cx, cz, angle);
        }
      }
    }
  }
}

// ------------------------------------------------------------- vehicles

function car(scene: Scene, x: number, z: number, angle: number, kind: "car" | "van" | "bus" = "car"): void {
  const random = scene.random;
  const ground = terrainHeight(x, z) + 0.2;
  if (kind === "bus") {
    scene.build({ x, z, angle, halfWidth: 6, halfDepth: 1.25, base: ground, height: 3, wall: rgb(196, 52, 42), roofColour: roofs.white, glass: 0.8, glassColour: rgb(40, 48, 58) });
    return;
  }
  if (kind === "van") {
    scene.build({ x, z, angle, halfWidth: 2.6, halfDepth: 1, base: ground, height: 1.9, wall: roofs.white, roofColour: roofs.white });
    return;
  }
  const paint = pick(random, paints);
  const body = scene.build({ x, z, angle, halfWidth: 2.2, halfDepth: 0.9, base: ground, height: 0.75, wall: paint, roofColour: paint });
  const shift = jitter(random, 0.4);
  scene.place(stack(body, { x: x - Math.cos(angle) * shift, z: z - Math.sin(angle) * shift, angle, halfWidth: 1.15, halfDepth: 0.8, height: 0.5, wall: rgb(40, 46, 54), roofColour: paint }));
}

function traffic(scene: Scene): void {
  const random = scene.random;
  for (const road of roads) {
    if (road.kind === "track") continue;
    for (const segment of road.segments) {
      const angle = Math.atan2(segment.dz, segment.dx);
      const nx = -segment.dz / segment.length;
      const nz = segment.dx / segment.length;
      // Moving traffic in both lanes.
      for (let d = 10 + random() * 30; d < segment.length - 8; d += 22 + random() * 40) {
        const lane = (random() < 0.5 ? -1 : 1) * road.halfWidth * 0.45;
        const x = segment.ax + (segment.dx * d) / segment.length + nx * lane;
        const z = segment.az + (segment.dz * d) / segment.length + nz * lane;
        if (junctions.some(([jx, jz]) => Math.hypot(jx - x, jz - z) < 12)) continue;
        const roll = random();
        car(scene, x, z, angle + (lane > 0 ? Math.PI : 0), road.kind === "town" && roll < 0.08 ? "bus" : roll < 0.2 ? "van" : "car");
      }
      // Cars parked along the kerbs in town.
      if (road.kind !== "town") continue;
      for (const side of [-1, 1]) {
        for (let d = 14; d < segment.length - 14; d += 6.2) {
          if (random() < 0.45) continue;
          const offset = side * (road.halfWidth - 1.2);
          const x = segment.ax + (segment.dx * d) / segment.length + nx * offset;
          const z = segment.az + (segment.dz * d) / segment.length + nz * offset;
          if (junctions.some(([jx, jz]) => Math.hypot(jx - x, jz - z) < 16) || Math.abs(riverDistance(x, z)) < bankOuter) continue;
          car(scene, x, z, angle);
        }
      }
    }
  }
}

// ----------------------------------------------------- street furniture

function streetFurniture(scene: Scene): void {
  const pole = rgb(70, 72, 76);
  const lamp = rgb(255, 234, 176);
  for (const road of roads) {
    if (road.kind !== "town") continue;
    for (const segment of road.segments) {
      const nx = -segment.dz / segment.length;
      const nz = segment.dx / segment.length;
      for (const side of [-1, 1]) {
        for (let d = 8 + (side > 0 ? 13 : 0); d < segment.length - 4; d += 26) {
          const offset = side * (road.halfWidth + 0.6);
          const x = segment.ax + (segment.dx * d) / segment.length + nx * offset;
          const z = segment.az + (segment.dz * d) / segment.length + nz * offset;
          if (junctions.some(([jx, jz]) => Math.hypot(jx - x, jz - z) < 10) || Math.abs(riverDistance(x, z)) < bankOuter) continue;
          const ground = terrainHeight(x, z);
          const head: Vec3 = [x - nx * side * 1.8, ground + 7.2, z - nz * side * 1.8];
          scene.add(
            lineSurface([x, ground, z], [x, ground + 7.4, z], 0.1, pole, 1.4),
            lineSurface([x, ground + 7.4, z], head, 0.08, pole, 1.4),
            lineSurface(head, [head[0] - nx * side * 0.6, head[1] - 0.1, head[2] - nz * side * 0.6], 0.2, lamp, 6),
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------- bridge

function bridge(scene: Scene): void {
  const west = terrainHeight(bridgeWestX, bridgeZ) - 0.02;
  const east = terrainHeight(bridgeEastX, bridgeZ) - 0.02;
  const length = bridgeEastX - bridgeWestX;
  const deckY = (x: number): number => {
    const t = (x - bridgeWestX) / length;
    return west + (east - west) * t + 0.8 * Math.sin(Math.PI * t);
  };
  const asphalt = rgb(52, 53, 57);
  const paving = rgb(178, 174, 166);
  const concrete = rgb(172, 170, 162);
  const steel = rgb(238, 238, 234);

  scene.add({
    weight: length * bridgeHalfWidth * 2,
    emit(random, out) {
      const x = bridgeWestX + random() * length;
      const across = jitter(random, bridgeHalfWidth * 2);
      const road = Math.abs(across) < 5;
      const marking = Math.abs(across) < 0.16 && ((x % 9) + 9) % 9 < 4.5;
      out.put(x, deckY(x) + (road ? 0 : 0.15), bridgeZ + across, marking ? rgb(236, 236, 226) : road ? asphalt : paving, 0.95, random, 10);
    },
  });
  for (const side of [-1, 1]) {
    // The deck's edge beam, and the railing along it.
    scene.add({
      weight: length * 1.4 * 0.5,
      emit(random, out) {
        const x = bridgeWestX + random() * length;
        out.put(x, deckY(x) - random() * 1.4, bridgeZ + side * (bridgeHalfWidth + 0.1), concrete, sunShade(0, 0.1, side), random, 10);
      },
    });
    scene.add(curveSurface(length, 1.2, 0.05, rgb(120, 124, 130), (t) => {
      const x = bridgeWestX + t * length;
      return [x, deckY(x) + 1.1, bridgeZ + side * (bridgeHalfWidth - 0.05)];
    }));
  }

  // A tied steel arch over the river: two ribs leaning towards each other, hangers holding up the deck.
  const centre = riverX(bridgeZ);
  const span = 23;
  const rise = 15;
  const rib = (s: number, side: number): Vec3 => {
    const x = centre + s * span;
    const lift = 1 - s * s;
    return [x, deckY(x) + rise * lift, bridgeZ + side * (bridgeHalfWidth + 0.4 - 2.4 * lift)];
  };
  for (const side of [-1, 1]) {
    scene.add(curveSurface(span * 2.6, 3.2, 0.5, steel, (t) => rib(t * 2 - 1, side)));
    for (let s = -0.9; s < 0.91; s += 0.15) {
      const [x, y, z] = rib(s, side);
      scene.add(lineSurface([x, deckY(x), bridgeZ + side * (bridgeHalfWidth + 0.4)], [x, y, z], 0.05, rgb(200, 202, 204), 1.2));
    }
  }
  for (const s of [-0.45, -0.15, 0.15, 0.45]) scene.add(lineSurface(rib(s, -1), rib(s, 1), 0.25, steel, 2));
}

function riverside(scene: Scene): void {
  const random = scene.random;
  // An avenue of trees along the town bank, willows at the water's edge, scattered trees on the far bank.
  for (let z = -sceneHalfDepth + 4; z < sceneHalfDepth - 4; z += 8 + random() * 3) {
    if (random() < 0.8) scene.plant(acrossRiver(z, -20.5 - random() * 2), z, false, 1);
    if (random() < 0.25) scene.plant(acrossRiver(z, -13), z, false, 1.25);
    if (random() < 0.4) scene.plant(acrossRiver(z, 15 + random() * 11), z, false, 1.1);
  }

  // Boats moored at a jetty on the town side, floating over water the laser cannot see.
  const jettyZ = 34;
  scene.place(makeBuilding({ x: acrossRiver(jettyZ, -10), z: jettyZ, angle: riverAngle(jettyZ) + Math.PI / 2, halfWidth: 5, halfDepth: 1.1, base: waterLevel + 0.5, height: 0.35, wall: rgb(116, 92, 68), roofColour: rgb(152, 122, 88) }));
  for (const [z, hull] of [[26, rgb(40, 60, 112)], [42, rgb(150, 44, 40)], [-48, rgb(236, 236, 230)]] as const) {
    const angle = riverAngle(z);
    const boat = scene.place(makeBuilding({ x: acrossRiver(z, -5.4), z, angle, halfWidth: 4.6, halfDepth: 1.6, base: waterLevel - 0.2, height: 1.2, wall: hull, roofColour: rgb(222, 216, 202) }));
    scene.place(stack(boat, { x: boat.cx, z: boat.cz, angle, halfWidth: 1.6, halfDepth: 1.2, height: 1.4, glass: 0.4, wall: rgb(236, 236, 232), roofColour: rgb(236, 236, 232) }));
  }
}

// ------------------------------------------------------ power and energy

function powerLine(scene: Scene): void {
  const length = Math.hypot(1, 0.055);
  const along = { x: 1 / length, z: -0.055 / length };
  const across = { x: -along.z, z: along.x };
  const galvanised = rgb(150, 156, 158);
  const conductor = rgb(172, 174, 178);
  const previous: Vec3[][] = [];

  for (const px of pylonXs) {
    const pz = powerLineZ(px);
    const base = lowestGround(px, pz, 4) - 0.2;
    const height = 30;
    const halfWidth = (h: number) => 4 - (2.8 * h) / height;
    const corner = (sa: number, sp: number, h: number): Vec3 => [
      px + (sa * along.x + sp * across.x) * halfWidth(h),
      base + h,
      pz + (sa * along.z + sp * across.z) * halfWidth(h),
    ];
    const at = (offset: number, h: number): Vec3 => [px + across.x * offset, base + h, pz + across.z * offset];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    const levels = [0, 6, 12, 18, 24, 30];
    const member = (a: Vec3, b: Vec3) => scene.add(lineSurface(a, b, 0.06, galvanised, 0.5));

    for (const [sa, sp] of corners) member(corner(sa, sp, 0), corner(sa, sp, height));
    for (let face = 0; face < 4; face += 1) {
      const [a1, p1] = corners[face]!;
      const [a2, p2] = corners[(face + 1) % 4]!;
      for (let level = 0; level < levels.length - 1; level += 1) {
        const low = levels[level]!;
        const high = levels[level + 1]!;
        member(corner(a1, p1, low), corner(a2, p2, high));
        member(corner(a2, p2, low), corner(a1, p1, high));
        member(corner(a1, p1, high), corner(a2, p2, high));
      }
    }
    // Cross-arms, the earth-wire peak, and insulators hanging from the arms.
    const attachments: Vec3[] = [];
    for (const [h, reach] of [[22, 7.5], [28, 5.8]] as const) {
      member(at(-reach, h), at(reach, h));
      for (const side of [-1, 1]) {
        member(at(side * reach, h), corner(0, side, h - 3));
        const tip = at(side * reach, h);
        const hang: Vec3 = [tip[0], tip[1] - 1.6, tip[2]];
        scene.add(lineSurface(tip, hang, 0.12, rgb(120, 140, 150), 2));
        attachments.push(hang);
      }
    }
    const apex: Vec3 = [px, base + height + 5, pz];
    for (const [sa, sp] of corners) member(corner(sa, sp, height), apex);
    attachments.push(apex);

    const last = previous[previous.length - 1];
    if (last !== undefined) {
      attachments.forEach((point, index) => scene.add(wireSurface(last[index]!, point, index === attachments.length - 1 ? 3.5 : 5.5, conductor)));
    }
    previous.push(attachments);
  }
}

function windTurbine(scene: Scene, x: number, z: number, facing: number, rotor: number): void {
  const base = lowestGround(x, z, 3) - 0.2;
  const hubHeight = 46;
  const white = rgb(236, 238, 240);
  const axis = { x: Math.cos(facing), z: Math.sin(facing) };

  scene.add({
    weight: 2 * Math.PI * 1.8 * hubHeight * 0.6,
    emit(random, out) {
      const h = random() * hubHeight;
      const radius = 2.2 - (0.9 * h) / hubHeight;
      const angle = random() * Math.PI * 2;
      out.put(x + Math.cos(angle) * radius, base + h, z + Math.sin(angle) * radius, white, sunShade(Math.cos(angle), 0.1, Math.sin(angle)), random, 8);
    },
  });
  scene.place(makeBuilding({ x: x + axis.x * 0.5, z: z + axis.z * 0.5, angle: facing, halfWidth: 5, halfDepth: 1.8, base: base + hubHeight - 1.6, height: 3.4, wall: white, roofColour: white }));

  const hub: Vec3 = [x + axis.x * 6, base + hubHeight + 0.2, z + axis.z * 6];
  const blade = 22;
  scene.add({
    weight: 3 * blade * 1.4 * 2.5,
    emit(random, out) {
      const theta = rotor + Math.floor(random() * 3) * ((Math.PI * 2) / 3);
      const r = 1.2 + random() * (blade - 1.2);
      const chord = 2.4 * (1 - (0.75 * r) / blade);
      const w = jitter(random, chord);
      const dirH = Math.cos(theta);
      const dirV = Math.sin(theta);
      // The rotor turns in the vertical plane square to the wind.
      const inPlane = r * dirH - w * dirV;
      const up = r * dirV + w * dirH;
      const depth = jitter(random, 0.3);
      out.put(hub[0] - axis.z * inPlane + axis.x * depth, hub[1] + up, hub[2] + axis.x * inPlane + axis.z * depth, white, 0.85 + random() * 0.2, random, 8);
    },
  });
}

function solarPanels(scene: Scene): void {
  const tilt = (25 * Math.PI) / 180;
  const panel = rgb(30, 44, 86);
  const frame = rgb(140, 150, 162);
  const shade = sunShade(0, Math.cos(tilt), Math.sin(tilt));
  for (let rowZ = solarFarm.minZ + 4; rowZ < solarFarm.maxZ - 3; rowZ += 6.5) {
    for (let cx = solarFarm.minX + 6.5; cx < solarFarm.maxX - 4; cx += 9.8) {
      if (pylonXs.some((px) => Math.abs(px - cx) < 9 && Math.abs(powerLineZ(px) - rowZ) < 9)) continue;
      const ground = terrainHeight(cx, rowZ);
      scene.add({
        weight: 9 * 4,
        emit(random, out) {
          const u = jitter(random, 9);
          const w = jitter(random, 4);
          const onFrame = ((u + 20) % 1.0) < 0.06 || ((w + 20) % 1.0) < 0.08;
          out.put(cx + u, ground + 0.8 + (2 - w) * Math.sin(tilt), rowZ + w * Math.cos(tilt), onFrame ? frame : panel, shade, random, 8);
        },
      });
    }
  }
}

// ------------------------------------------------------------------ trees

function trees(scene: Scene): void {
  const random = scene.random;

  // Street trees in pits along the town's pavements.
  for (const road of roads) {
    if (road.kind !== "town") continue;
    for (const segment of road.segments) {
      const nx = -segment.dz / segment.length;
      const nz = segment.dx / segment.length;
      for (const side of [-1, 1]) {
        for (let d = 6 + (side > 0 ? 6 : 0); d < segment.length - 4; d += 13) {
          const offset = side * (road.halfWidth + sidewalkWidth - 0.8);
          const x = segment.ax + (segment.dx * d) / segment.length + nx * offset;
          const z = segment.az + (segment.dz * d) / segment.length + nz * offset;
          if (junctions.some(([jx, jz]) => Math.hypot(jx - x, jz - z) < 14)) continue;
          scene.plant(x, z, false, 0.8, { street: true, anyZone: true });
        }
      }
    }
  }

  // Hedgerows between the fields.
  for (let z = 104; z < 168; z += 5 + random() * 3) scene.plant(-146 + jitter(random, 1), z, false, 0.85, { anyZone: true });
  for (let x = -64; x < -10; x += 5 + random() * 3) scene.plant(x, 137 + jitter(random, 1), false, 0.8, { anyZone: true });
  for (let z = 104; z < 168; z += 6 + random() * 4) scene.plant(-4 + jitter(random, 1), z, random() < 0.3, 0.9, { anyZone: true });

  // The hillside forest: broadleaf low down, conifers taking over with height.
  const spacing = 6.8;
  for (let z = -sceneHalfDepth + 2; z < sceneHalfDepth - 1; z += spacing) {
    for (let x = 60; x < 219; x += spacing) {
      const tx = x + jitter(random, spacing * 0.8);
      const tz = z + jitter(random, spacing * 0.8);
      if (Math.abs(tx) > 219 || Math.abs(tz) > sceneHalfDepth - 1) continue;
      if (!forestAt(tx, tz)) {
        // The odd lone tree in the meadows.
        if (random() < 0.04 && riverDistance(tx, tz) > bankOuter) scene.plant(tx, tz, false, 1.1);
        continue;
      }
      const conifer = random() < 0.1 + 0.8 * smoothstep(9, 21, terrainHeight(tx, tz));
      scene.plant(tx, tz, conifer, 0.85 + random() * 0.45);
    }
  }

  // Gardens and verges scattered through the rest of the town.
  for (let index = 0; index < 120; index += 1) {
    const x = -215 + random() * 230;
    const z = -165 + random() * 255;
    if (riverDistance(x, z) > -bankOuter) continue;
    scene.plant(x, z, random() < 0.12, 0.8 + random() * 0.4);
  }
}
