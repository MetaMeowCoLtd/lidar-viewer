import { useEffect, useRef, useState } from "react";
import { LidarViewer } from "../../three/lidar-viewer.js";
import { ProceduralCloudGenerator } from "../../core/procedural-cloud-generator.js";
import { createLodSpecs } from "../lod-specs.js";

/**
 * The hero's live scene: the sample city turning slowly in a real viewer, so
 * the first thing a visitor sees is the product working rather than a picture
 * of it. Wheel zoom is off so scrolling past it scrolls the page, and on touch
 * screens vertical swipes still scroll while sideways drags turn the scene.
 */
export function LandingPreview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const viewer = new LidarViewer(canvas, { pointBudget: 500_000, pointSize: 2.4, framingDistance: 0.52 });
    canvas.style.touchAction = "pan-y";
    viewer.setZoomEnabled(false);
    viewer.setAutoRotate(!window.matchMedia("(prefers-reduced-motion: reduce)").matches, 0.5);
    viewer.setColorMode("rgb");
    const unsubscribe = viewer.session.subscribe((state) => {
      if (state.status === "ready") setReady(true);
    });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) viewer.resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(canvas.parentElement!);
    viewer.start();
    const cloud = new ProceduralCloudGenerator().generate({ pointCount: 450_000, seed: 21, name: "Sample riverside town" });
    void viewer.load(cloud, createLodSpecs(cloud.bounds.diagonal));
    return () => {
      unsubscribe();
      observer.disconnect();
      viewer.dispose();
    };
  }, []);

  return (
    <div className={ready ? "lp-preview is-ready" : "lp-preview"}>
      <canvas ref={canvasRef} aria-label="A live 3D preview of the sample city scan, turning slowly" />
      <div className="lp-preview-badge">
        <span className="lp-live-dot" />
        Live preview · drag to turn
      </div>
    </div>
  );
}
