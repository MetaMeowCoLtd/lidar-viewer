import { useEffect, useState } from "react";

/** `sample` names the sample survey to open, from `#/app?sample=<id>`. */
export type Route = { readonly page: "landing" } | { readonly page: "app"; readonly sample?: string } | { readonly page: "benchmark" };

/**
 * Pages are addressed by the URL's hash - `#/` for the landing page, `#/app`
 * for the workspace. The site is served as static files from GitHub Pages,
 * which cannot rewrite `/app` back to `index.html`, and a hash route needs no
 * rewrite at all.
 */
export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  if (path === "/app") {
    const sample = new URLSearchParams(query).get("sample");
    return sample === null ? { page: "app" } : { page: "app", sample };
  }
  if (path === "/benchmark") return { page: "benchmark" };
  return { page: "landing" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const appHref = "#/app";
export const sampleHref = "#/app?sample=default";
export const landingHref = "#/";
export const benchmarkHref = "#/benchmark";
