/**
 * The sample: a real drone survey rather than a made-up one. A DJI Matrice
 * 350 RTK carrying a Zenmuse L1 flew Virginia Tech's StREAM Lab, a stream
 * research site on farmland, in August 2024. The files here are a patch of
 * that survey, cropped and thinned evenly so they download in seconds; every
 * point kept is as the scanner recorded it, with its class, colour,
 * intensity, returns and flight line.
 */
export const sampleSurvey = {
  name: "StREAM Lab drone survey",
  /** The patch the workspace opens. */
  url: "samples/streamlab-2024.laz",
  /** A lighter copy of the same patch for the landing page's live preview. */
  previewUrl: "samples/streamlab-2024-preview.laz",
  credit: "Hession, W., Lehmann, L., Resop, J., Kobayashi, Y. (2026). Virginia Tech StREAM Lab Summer 2024 Drone Lidar Survey. Distributed by OpenTopography.",
  licence: "CC BY 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  sourceUrl: "https://doi.org/10.5069/G9J67F57",
} as const;

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
