/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public URL included in share text. Defaults to window.location.origin. */
  readonly VITE_PUBLIC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
