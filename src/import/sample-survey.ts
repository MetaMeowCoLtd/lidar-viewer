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
      "A stream research site on farmland: the stream and the trees along its banks, a gravel farm road and its bridge, trails and pasture. The survey was flown in two flights of parallel passes.",
    why:
      "Environmental and water work: stream restoration, flood and erosion studies, riparian vegetation. What matters there is the ground under the trees, how tall the canopy stands, and whether the passes line up well enough to measure change between surveys.",
    tryThis: [
      "Analyze the scan and colour by height above ground to see the canopy over the stream",
      "Build the terrain to follow the stream channel under the trees",
      "Colour by flight line to see each pass and where passes overlap",
    ],
    prepared:
      "Cropped from the full survey and thinned evenly to one point in seventeen. The published files carry no flight lines, so each point's line was recovered from its GPS time.",
    credit: "Hession, W., Lehmann, L., Resop, J., Kobayashi, Y. (2026). Virginia Tech StREAM Lab Summer 2024 Drone Lidar Survey. Distributed by OpenTopography.",
    ...ccBy,
    sourceUrl: "https://doi.org/10.5069/G9J67F57",
    url: "samples/streamlab-2024.laz",
    previewUrl: "samples/streamlab-2024-preview.laz",
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
