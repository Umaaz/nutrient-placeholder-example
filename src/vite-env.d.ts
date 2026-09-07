/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NUTRIENT_LICENSE_KEY?: string;
  /** Vite's `base`, always with a trailing slash. "/" locally, "/<repo>/" on Pages. */
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
