import { Icon, type IconName } from "../icons.js";
import { appHref, sampleHref } from "../router.js";
import { LandingPreview } from "./LandingPreview.js";

const features: readonly { icon: IconName; title: string; text: string }[] = [
  { icon: "scan", title: "Opens big scans", text: "Streams LAS, LAZ and PLY files on a background worker, so a 60-million-point scan loads without freezing the page." },
  { icon: "mountain", title: "Finds the ground", text: "Separates bare earth from everything standing on it, and measures how high every point sits above the ground." },
  { icon: "building", title: "Counts buildings and trees", text: "Outlines each building and tree it finds, with its footprint, height and crown size." },
  { icon: "layers", title: "Builds terrain", text: "Turns the ground into a shaded 3D surface with contour lines at round elevations." },
  { icon: "ruler", title: "Measures anything", text: "Click a point for its coordinates, class and height, or two points for distance, height difference and slope." },
  { icon: "download", title: "Exports for GIS and CAD", text: "Classified LAS, GeoTIFF elevation, GeoJSON layers and CSV inventories, in the scan's own coordinate system." },
];

const steps: readonly { title: string; text: string }[] = [
  { title: "Open a scan", text: "Drop a LAS, LAZ or PLY file, or start with the sample city." },
  { title: "Analyze", text: "Find the ground, build the terrain and count buildings and trees in seconds." },
  { title: "Export", text: "Download results ready for QGIS, ArcGIS or your CAD tool." },
];

export function Landing() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <a className="logo" href="#/" aria-label="Vertex LiDAR home">
          <Icon name="logo" className="logo-mark" />
          Vertex LiDAR
        </a>
        <nav className="lp-nav-links" aria-label="Page sections">
          <a href="#features" onClick={scrollTo("features")}>Features</a>
          <a href="#how-it-works" onClick={scrollTo("how-it-works")}>How it works</a>
          <a href="#privacy" onClick={scrollTo("privacy")}>Privacy</a>
        </nav>
        <a className="btn btn-primary" href={appHref}>
          Open the app
        </a>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">
              <Icon name="shield" /> Runs entirely in your browser
            </p>
            <h1>Turn LiDAR scans into answers</h1>
            <p className="lp-lead">
              Open scans of any size, find the ground, count buildings and trees, build terrain and measure anything. Then
              export for GIS and CAD. Your data never leaves your device.
            </p>
            <div className="lp-actions">
              <a className="btn btn-primary btn-lg" href={appHref}>
                Open the app <Icon name="arrowRight" />
              </a>
              <a className="btn btn-lg" href={sampleHref}>
                <Icon name="city" /> Try the sample city
              </a>
            </div>
            <ul className="lp-facts">
              <li>LAS, LAZ and PLY</li>
              <li>Up to 60M points</li>
              <li>No upload, no account</li>
            </ul>
          </div>
          <LandingPreview />
        </section>

        <section className="lp-section" id="features" aria-labelledby="features-title">
          <h2 id="features-title">Everything between the raw scan and the deliverable</h2>
          <p className="lp-section-lead">Analysis that usually needs desktop GIS software, running in a browser tab.</p>
          <div className="lp-features">
            {features.map((feature) => (
              <article className="lp-feature" key={feature.title}>
                <span className="lp-feature-icon">
                  <Icon name={feature.icon} />
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-section" id="how-it-works" aria-labelledby="steps-title">
          <h2 id="steps-title">How it works</h2>
          <ol className="lp-steps">
            {steps.map((step, index) => (
              <li key={step.title}>
                <span className="lp-step-number">{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-section" id="privacy" aria-labelledby="privacy-title">
          <div className="lp-privacy">
            <span className="lp-privacy-icon">
              <Icon name="shield" />
            </span>
            <div>
              <h2 id="privacy-title">Private by design</h2>
              <p>
                Reading, analysis and export all happen on your device. Nothing is uploaded, so client scans stay
                confidential and nothing needs an account.
              </p>
            </div>
            <a className="btn btn-primary btn-lg" href={appHref}>
              Open the app
            </a>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span className="logo">
          <Icon name="logo" className="logo-mark" />
          Vertex LiDAR
        </span>
        <span>Reads LAS, LAZ and PLY · Exports LAS, GeoTIFF, GeoJSON and CSV</span>
      </footer>
    </div>
  );
}

/** In-page links scroll instead of changing the hash, which addresses pages here. */
function scrollTo(id: string) {
  return (event: { preventDefault(): void }) => {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}
