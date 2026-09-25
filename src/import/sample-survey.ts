/**
 * The sample surveys: real drone scans, each chosen for a kind of job a drone
 * survey company is hired for, so a visitor can try the app on something like
 * their own work. Each is a patch of a published survey, cropped and thinned
 * evenly so it downloads in seconds; every point kept is as the scanner
 * recorded it.
 */
export interface SampleSurvey {
  readonly id: string;
  readonly name: string;
  /** One line for the Samples menu. */
  readonly summary: string;
  readonly place: string;
  readonly captured: string;
  readonly platform: string;
  readonly area: string;
  /** What the scan shows. */
  readonly about: string;
  /** The work a scan like this is flown for, and what to look at here. */
  readonly why: string;
  readonly tryThis: readonly string[];
  /** What was done to the published data to make the sample. */
  readonly prepared: string;
  readonly credit: string;
  /** The credit in a few words, for the attribution line on the scan. */
  readonly creditShort: string;
  readonly licence: string;
  readonly licenceUrl: string;
  readonly sourceUrl: string;
  readonly url: string;
  /** A lighter copy for the landing page's live preview. */
  readonly previewUrl?: string;
}

const ccBy = { licence: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/" } as const;

export const sampleSurveys: readonly SampleSurvey[] = [
  {
    id: "streamlab",
    name: "Stream corridor, Virginia",
    summary: "Stream, wooded banks, farm road and fields",
    place: "Virginia Tech StREAM Lab, Blacksburg, Virginia, USA",
    captured: "August 2024, leaf-on",
    platform: "DJI Matrice 350 RTK with a Zenmuse L1",
    area: "230 × 150 m, 4.1 million points",
    about:
      "A stream research site on farmland: the stream and the trees along its banks, a gravel farm road and its bridge, trails and pasture. The drone flew it in two flights, each a lawnmower pattern of straight, overlapping passes; 11 of those passes (flight lines) cross this patch, numbered in the order they were flown.",
    why:
      "Environmental and water work: stream restoration, flood and erosion studies, riparian vegetation. What matters there is the ground under the trees, how tall the canopy stands, and whether the passes line up well enough to measure change between surveys.",
    tryThis: [
      "Analyze the scan and colour by height above ground to see the canopy over the stream",
      "Build the terrain to follow the stream channel under the trees",
      "Colour by flight line to see each pass of the drone as a strip, and where neighbouring strips overlap",
    ],
    prepared:
      "Cropped from the full survey and thinned evenly to one point in seventeen. The published files carry no flight lines, so each point's line was recovered from its GPS time.",
    credit: "Hession, W., Lehmann, L., Resop, J., Kobayashi, Y. (2026). Virginia Tech StREAM Lab Summer 2024 Drone Lidar Survey. Distributed by OpenTopography.",
    creditShort: "Virginia Tech StREAM Lab, via OpenTopography",
    ...ccBy,
    sourceUrl: "https://doi.org/10.5069/G9J67F57",
    url: "samples/streamlab-2024.laz",
    previewUrl: "samples/streamlab-2024-preview.laz",
  },
  {
    id: "vineyard",
    name: "Vineyard, Galicia",
    summary: "Vine rows flown low for crop monitoring, unclassified",
    place: "Tomiño, Pontevedra, Spain",
    captured: "July 2022, mid-season",
    platform: "DJI Matrice 300 RTK with a Zenmuse L1, 30 m above the vines at 4 m/s",
    area: "94 × 127 m, the whole block, 3.5 million points",
    about:
      "A vineyard block scanned for the EU FLEXIGROBOTS project: trellised rows of vines with grass between them, flown low and slow in six straight, overlapping passes (flight lines) for dense, even coverage.",
    why:
      "Precision agriculture: counting and measuring vine rows, canopy height and volume, and gaps where plants have died, to plan pruning, spraying and harvest. The scan arrives unclassified, as it comes off the drone, so this is the raw material an agronomy service starts from.",
    tryThis: [
      "Analyze the scan: the ground between the rows is found and the vines stand out by height",
      "Colour by height above ground to read canopy height row by row",
      "Measure a row's spacing and a vine's height with the ruler",
    ],
    prepared: "The whole block, thinned evenly to one point in five. The published file carries no flight lines, so each point's line was recovered from its GPS time.",
    credit: "Vélez, S., Ariza-Sentís, M., Valente, J. (2023). High resolution LiDAR dataset acquired using UAV over two vineyards and two years located in Tomiño, Pontevedra, Spain. Zenodo.",
    creditShort: "Vélez, Ariza-Sentís and Valente, VineLiDAR",
    ...ccBy,
    sourceUrl: "https://doi.org/10.5281/zenodo.8113105",
    url: "samples/vineyard-2022.laz",
  },
  {
    id: "campus",
    name: "City campus, Munich",
    summary: "University buildings, courtyards and streets in a city centre",
    place: "Technical University of Munich, city-centre campus, Germany",
    captured: "December 2024, leaf-off",
    platform: "DJI Matrice 350 RTK with a Zenmuse L2, RTK-corrected over the Bavarian SAPOS network",
    area: "250 × 190 m, 4.1 million points",
    about:
      "The core of TUM's city-centre campus: university buildings from the 19th century to today, with flat and pitched roofs, inner courtyards, a curved lecture hall, and the streets and parked cars around them. Flown in two crossing missions of straight passes (flight lines) for the TUM2TWIN digital twin project.",
    why:
      "Urban mapping and building work: digital twins and 3D city models, roof inspection and solar planning, as-built surveys before construction, and street-level asset inventories. Buildings are what a city client pays for, so this is the scan to test footprints, heights and roof shapes on.",
    tryThis: [
      "Analyze the scan and count buildings: each one is outlined with its footprint and height",
      "Measure a building's height and the width of a street with the ruler",
      "Colour by flight line: the two missions cross each other, so every roof is seen from several passes",
    ],
    prepared:
      "Cropped from the nadir missions of the survey and thinned evenly to one point in twenty. Each point's flight line was taken from the drone's recorded trajectory, which the survey publishes alongside the scan.",
    credit: "Anders, K., Wang, J., Wysocki, O., Huang, X., Liu, S. (2025). UAV Laser Scanning and Photogrammetry of TUM Downtown Campus. Zenodo.",
    creditShort: "Technical University of Munich, TUM2TWIN",
    ...ccBy,
    sourceUrl: "https://doi.org/10.5281/zenodo.15282970",
    url: "samples/tum-campus-2024.laz",
  },
];

/** The sample opened by default, and by the landing page's button. */
export const defaultSample = sampleSurveys[0]!;

export function findSample(id: string | undefined): SampleSurvey | undefined {
  return sampleSurveys.find((sample) => sample.id === id);
}

/**
 * Downloads a sample file as a `File`, so it goes through the same import
 * path as a scan the user drops in, reporting how much has arrived.
 */
export async function fetchSampleFile(url: string, onProgress?: (fraction: number) => void): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The sample survey couldn't be downloaded (HTTP ${response.status})`);
  const name = url.slice(url.lastIndexOf("/") + 1);
  const total = Number(response.headers.get("content-length") ?? 0);
  if (response.body === null || total === 0) return new File([await response.blob()], name);

  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onProgress?.(Math.min(1, received / total));
  }
  return new File(parts as BlobPart[], name);
}
