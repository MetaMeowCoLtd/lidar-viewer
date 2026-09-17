/**
 * The coordinate reference system a scan was delivered in.
 *
 * A LAS file declares its system in variable-length records, either as
 * GeoTIFF keys (the older form) or as WKT text (required from point format 6
 * onwards). The viewer never reprojects, so it has no use for the definition
 * itself - but an export that drops it hands a GIS user coordinates with no
 * way to place them. The records are therefore carried verbatim from import to
 * export, and the one fact a lightweight format can use, the EPSG code, is
 * read out of them where it can be.
 */
export interface SpatialReferenceRecord {
  readonly userId: string;
  readonly recordId: number;
  readonly description: string;
  readonly data: Uint8Array;
}

export interface SpatialReference {
  /** The source file's CRS records, byte for byte. */
  readonly records: readonly SpatialReferenceRecord[];
  /** The WKT definition, when the file carried one. */
  readonly wkt?: string;
  /** The EPSG code of the horizontal system, when one could be identified. */
  readonly epsg?: number;
}

export const projectionUserId = "LASF_Projection";
export const geoKeyDirectoryRecordId = 34735;
export const geoDoubleParamsRecordId = 34736;
export const geoAsciiParamsRecordId = 34737;
export const ogcWktRecordId = 2112;
/** The mathematical-transform WKT record, which is not a CRS on its own and is carried but never read. */
export const ogcMathTransformWktRecordId = 2111;

const crsRecordIds = new Set([
  geoKeyDirectoryRecordId,
  geoDoubleParamsRecordId,
  geoAsciiParamsRecordId,
  ogcWktRecordId,
  ogcMathTransformWktRecordId,
]);

export function isSpatialReferenceRecord(userId: string, recordId: number): boolean {
  return userId === projectionUserId && crsRecordIds.has(recordId);
}

/** Assembles a reference from the CRS records found in a file, or undefined when there were none. */
export function spatialReferenceFromRecords(records: readonly SpatialReferenceRecord[]): SpatialReference | undefined {
  if (records.length === 0) return undefined;
  const wktRecord = records.find((record) => record.recordId === ogcWktRecordId);
  const wkt = wktRecord === undefined ? undefined : decodeNullTerminated(wktRecord.data).trim();
  const geoKeys = records.find((record) => record.recordId === geoKeyDirectoryRecordId);
  const epsg =
    (wkt === undefined || wkt === "" ? undefined : epsgFromWkt(wkt)) ??
    (geoKeys === undefined ? undefined : epsgFromGeoKeys(geoKeys.data));
  return {
    records,
    ...(wkt === undefined || wkt === "" ? {} : { wkt }),
    ...(epsg === undefined ? {} : { epsg }),
  };
}

/**
 * The EPSG code of a WKT definition's horizontal system.
 *
 * Every element of a WKT string carries its own authority, and a projected
 * system nests a geographic one, which nests a datum, each with a code of its
 * own - so the code that names the whole system is the one attached to the
 * outermost element, not simply the first or last to appear. A compound system
 * pairs a horizontal and a vertical system and often has no code itself; its
 * horizontal half, which comes first, is what a map layer needs.
 *
 * Handles both WKT1 (`AUTHORITY["EPSG","32654"]`) and WKT2 (`ID["EPSG",32654]`).
 */
export function epsgFromWkt(wkt: string): number | undefined {
  const root = parseWktElement(wkt, 0);
  if (root === undefined) return undefined;
  const own = authorityOf(root);
  if (own !== undefined) return own;
  if (root.keyword === "COMPD_CS" || root.keyword === "COMPOUNDCRS") {
    const horizontal = root.children.find((child) => child.keyword !== "AUTHORITY" && child.keyword !== "ID");
    return horizontal === undefined ? undefined : authorityOf(horizontal);
  }
  return undefined;
}

/**
 * The EPSG code in a GeoTIFF key directory: the projected system when there is
 * one, else the geographic system. 32767 is GeoTIFF's marker for a system
 * defined by parameters rather than by code, and names nothing.
 */
export function epsgFromGeoKeys(directory: Uint8Array): number | undefined {
  if (directory.byteLength < 8) return undefined;
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const keyCount = view.getUint16(6, true);
  const found = new Map<number, number>();
  for (let key = 0; key < keyCount; key += 1) {
    const base = 8 + key * 8;
    if (base + 8 > directory.byteLength) break;
    const id = view.getUint16(base, true);
    const location = view.getUint16(base + 2, true);
    // A location of zero means the value is stored inline in the entry.
    if (location === 0) found.set(id, view.getUint16(base + 6, true));
  }
  for (const key of [projectedCrsKey, geographicCrsKey]) {
    const code = found.get(key);
    if (code !== undefined && code > 0 && code !== userDefined) return code;
  }
  return undefined;
}

const geographicCrsKey = 2048;
const projectedCrsKey = 3072;
const userDefined = 32767;

interface WktElement {
  readonly keyword: string;
  /** Unquoted scalar arguments, in order. */
  readonly values: readonly string[];
  readonly children: readonly WktElement[];
  readonly end: number;
}

function authorityOf(element: WktElement): number | undefined {
  for (const child of element.children) {
    if ((child.keyword === "AUTHORITY" || child.keyword === "ID") && child.values[0]?.toUpperCase() === "EPSG") {
      const code = Number(child.values[1]);
      if (Number.isInteger(code) && code > 0) return code;
    }
  }
  return undefined;
}

/** A small recursive-descent reader for WKT's `KEYWORD[value, "text", CHILD[...]]` shape. */
function parseWktElement(text: string, start: number): WktElement | undefined {
  let index = skipSpace(text, start);
  const keywordStart = index;
  while (index < text.length && /[A-Za-z0-9_]/.test(text[index]!)) index += 1;
  const keyword = text.slice(keywordStart, index).toUpperCase();
  index = skipSpace(text, index);
  if (keyword === "" || (text[index] !== "[" && text[index] !== "(")) return undefined;
  index += 1;

  const values: string[] = [];
  const children: WktElement[] = [];
  for (;;) {
    index = skipSpace(text, index);
    const char = text[index];
    if (char === undefined) return undefined;
    if (char === "]" || char === ")") return { keyword, values, children, end: index + 1 };
    if (char === ",") {
      index += 1;
      continue;
    }
    if (char === '"') {
      // A doubled quote is an escaped quote inside the string.
      let value = "";
      index += 1;
      for (;;) {
        const next = text[index];
        if (next === undefined) return undefined;
        if (next === '"') {
          if (text[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += next;
        index += 1;
      }
      values.push(value);
      continue;
    }
    let scan = index;
    while (scan < text.length && /[A-Za-z0-9_.+-]/.test(text[scan]!)) scan += 1;
    const after = skipSpace(text, scan);
    if (scan > index && (text[after] === "[" || text[after] === "(")) {
      const child = parseWktElement(text, index);
      if (child === undefined) return undefined;
      children.push(child);
      index = child.end;
    } else if (scan > index) {
      values.push(text.slice(index, scan));
      index = scan;
    } else {
      return undefined;
    }
  }
}

function skipSpace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}

function decodeNullTerminated(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}
