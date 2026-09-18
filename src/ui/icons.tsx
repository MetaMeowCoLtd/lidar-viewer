/**
 * The interface's icons: simple 24 by 24 outline drawings in the text colour,
 * kept inline so the app ships no icon font or library for a couple of dozen
 * glyphs.
 */
const paths = {
  logo: ["M12 2.5 21.5 12 12 21.5 2.5 12Z", "M9 14.5v-2", "M12 16v-6", "M15 14.5v-4"],
  upload: ["M12 16V4", "M7 9l5-5 5 5", "M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1", "M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.5 12H6.4a2 2 0 0 0-1.9 1.4L3 17"],
  download: ["M12 4v12", "M7 11l5 5 5-5", "M5 20h14"],
  chevronDown: ["M6 9l6 6 6-6"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z", "M14 3v5h5"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z"],
  sparkles: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z", "M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"],
  sliders: ["M4 6h9", "M17 6h3", "M15 4v4", "M4 12h3", "M11 12h9", "M9 10v4", "M4 18h11", "M19 18h1", "M17 16v4"],
  pointer: ["M5 3l14 7-6 2-2 6Z"],
  ruler: ["M3 17 17 3l4 4L7 21Z", "M7 13l2 2", "M10 10l2 2", "M13 7l2 2"],
  focus: ["M4 8V5a1 1 0 0 1 1-1h3", "M16 4h3a1 1 0 0 1 1 1v3", "M20 16v3a1 1 0 0 1-1 1h-3", "M8 20H5a1 1 0 0 1-1-1v-3", "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  check: ["M5 12l5 5 9-10"],
  alert: ["M12 8v5", "M12 16.5v.5", "M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"],
  shield: ["M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6Z", "M9 12l2 2 4-4"],
  mountain: ["M3 20 9.5 9l4 6.5L16 12l5 8Z"],
  building: ["M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16", "M16 9h2a2 2 0 0 1 2 2v10", "M3 21h18", "M8 7h4", "M8 11h4", "M8 15h4"],
  tree: ["M12 21v-5", "M12 3 6 12h3l-3 4h12l-3-4h3Z"],
  layers: ["M12 3 2 8l10 5 10-5Z", "M2 13l10 5 10-5"],
  gauge: ["M12 14l4-4", "M3.5 17a9 9 0 1 1 17 0"],
  scan: ["M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2", "M7 12h10"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  info: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z", "M12 11v5", "M12 8v.5"],
  play: ["M7 4v16l13-8Z"],
  city: ["M3 21h18", "M5 21V10l5-3v14", "M10 21V4h6v17", "M16 21v-8h3v8", "M13 8h.5", "M13 12h.5", "M13 16h.5"],
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = "icon", label }: { name: IconName; className?: string; label?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? undefined : "img"}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
    >
      {paths[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
