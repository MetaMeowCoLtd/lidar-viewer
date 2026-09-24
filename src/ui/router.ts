import { useEffect, useState } from "react";

export type Route = { readonly page: "landing" } | { readonly page: "app"; readonly sample: boolean } | { readonly page: "benchmark" };

/**
 * Pages are addressed by the URL's hash - `#/` for the landing page, `#/app`
 * for the workspace. The site is served as static files from GitHub Pages,
 * which cannot rewrite `/app` back to `index.html`, and a hash route needs no
 * rewrite at all.
 */
export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  if (path === "/app") return { page: "app", sample: new URLSearchParams(query).get("sample") === "city" };
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
export const sampleHref = "#/app?sample=city";
export const landingHref = "#/";
export const benchmarkHref = "#/benchmark";
