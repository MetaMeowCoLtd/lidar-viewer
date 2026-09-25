import type { PointCloudColorMode } from "../../core/point-cloud.js";

export interface ColourChoice {
  readonly value: PointCloudColorMode;
  readonly label: string;
  readonly hint?: string;
  readonly disabled: boolean;
}

const labels: Record<PointCloudColorMode, string> = {
  height: "Height",
  rgb: "RGB",
  intensity: "Intensity",
  relief: "Relief",
  classification: "Classes",
  heightAboveGround: "Above ground",
  objects: "Objects",
  flightLine: "Flight lines",
};

export function colorModeLabel(mode: PointCloudColorMode): string {
  return labels[mode];
}

/** What each colour mode shows, and what a scan must carry before it can. */
export function colorModeChoices(supports: {
  rgb: boolean;
  intensity: boolean;
  classification: boolean;
  heightAboveGround: boolean;
  objects: boolean;
  flightLine: boolean;
}): readonly ColourChoice[] {
  return [
    { value: "rgb", label: labels.rgb, hint: supports.rgb ? "The scan's own colour" : "This scan has no colour", disabled: !supports.rgb },
    {
      value: "intensity",
      label: labels.intensity,
      hint: supports.intensity ? "How strongly each surface returned the laser" : "This scan has no intensity",
      disabled: !supports.intensity,
    },
    { value: "height", label: labels.height, hint: "Elevation, low to high", disabled: false },
    { value: "relief", label: labels.relief, hint: "Shaded to bring out shape", disabled: false },
    {
      value: "classification",
      label: labels.classification,
      hint: supports.classification ? "Ground, buildings, vegetation" : "Detect ground or count first",
      disabled: !supports.classification,
    },
    {
      value: "heightAboveGround",
      label: labels.heightAboveGround,
      hint: supports.heightAboveGround ? "How high each point stands" : "Detect ground first",
      disabled: !supports.heightAboveGround,
    },
    {
      value: "objects",
      label: labels.objects,
      hint: supports.objects ? "A colour per building and tree" : "Count buildings and trees first",
      disabled: !supports.objects,
    },
    {
      value: "flightLine",
      label: labels.flightLine,
      hint: supports.flightLine ? "A colour per pass of the aircraft" : "This scan does not record its flight lines",
      disabled: !supports.flightLine,
    },
  ];
}
