/** Vite resolves a `?url` import to the emitted asset's runtime URL. */
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
