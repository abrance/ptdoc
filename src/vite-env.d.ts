/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SITE_TITLE?: string;
  readonly VITE_DEFAULT_DOC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
