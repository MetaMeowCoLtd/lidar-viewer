/**
 * ASPRS standard point classes and the colours conventionally used to draw
 * them.
 *
 * The codes are fixed by the LAS specification, which is what makes a
 * classified file portable between tools at all. Codes 0 through 22 are
 * defined; 23 to 63 are reserved, and 64 upwards are left to the vendor that
 * wrote the file, so anything this table does not name is shown as an unnamed
 * code rather than silently folded into another class.
 *
 * The palette follows what the desktop tools in this field already use, so a
 * scan opened here looks like the same scan opened anywhere else. Ground is
 * earth-brown, vegetation runs low-to-high through greens, buildings are
 * terracotta, water is blue and the power network is yellow.
 */
export interface PointClass {
  readonly code: number;
  readonly name: string;
  /** Hex colour, as used by the renderer's palette and any legend. */
  readonly color: string;
}

export const pointClasses: readonly PointClass[] = [
  { code: 0, name: "Never classified", color: "#8d99a6" },
  { code: 1, name: "Unclassified", color: "#b6bfc7" },
  { code: 2, name: "Ground", color: "#a2764a" },
  { code: 3, name: "Low vegetation", color: "#8fbf5a" },
  { code: 4, name: "Medium vegetation", color: "#5d9e43" },
  { code: 5, name: "High vegetation", color: "#2f7a34" },
  { code: 6, name: "Building", color: "#c0553c" },
  { code: 7, name: "Low noise", color: "#7a3f6d" },
  { code: 8, name: "Model key-point", color: "#d98cb3" },
  { code: 9, name: "Water", color: "#2f7fc1" },
  { code: 10, name: "Rail", color: "#6f5b8e" },
  { code: 11, name: "Road surface", color: "#5c6570" },
  { code: 12, name: "Overlap", color: "#9aa2ab" },
  { code: 13, name: "Wire, guard", color: "#d8b94a" },
  { code: 14, name: "Wire, conductor", color: "#e0c33f" },
  { code: 15, name: "Transmission tower", color: "#b08a2e" },
  { code: 16, name: "Wire connector", color: "#cfae55" },
  { code: 17, name: "Bridge deck", color: "#9c6f4f" },
  { code: 18, name: "High noise", color: "#a3427c" },
  { code: 19, name: "Overhead structure", color: "#7f8b96" },
  { code: 20, name: "Ignored ground", color: "#8a7154" },
  { code: 21, name: "Snow", color: "#e8eef2" },
  { code: 22, name: "Temporal exclusion", color: "#6b7480" },
];

/** Colour used for codes outside the standard table, including vendor ranges. */
export const unnamedClassColor = "#4d5560";

const byCode = new Map(pointClasses.map((pointClass) => [pointClass.code, pointClass]));

export function classificationName(code: number): string {
  return byCode.get(code)?.name ?? `Class ${code}`;
}

export function classificationColor(code: number): string {
  return byCode.get(code)?.color ?? unnamedClassColor;
}

/**
 * The full 256-entry palette as packed RGB bytes, in class-code order. The
 * renderer uploads this once as a lookup so a point's colour is a single
 * indexed read rather than a branch per class.
 */
export function classificationPaletteBytes(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  for (let code = 0; code < 256; code += 1) {
    const hex = classificationColor(code);
    palette[code * 3] = Number.parseInt(hex.slice(1, 3), 16);
    palette[code * 3 + 1] = Number.parseInt(hex.slice(3, 5), 16);
    palette[code * 3 + 2] = Number.parseInt(hex.slice(5, 7), 16);
  }
  return palette;
}
