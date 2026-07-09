/// <reference types="electron-vite/node" />

// Build-time env vars electron-vite inlines into the main bundle. Only vars
// prefixed with MAIN_VITE_ are exposed (see .env.example / electron-vite docs).
interface ImportMetaEnv {
  readonly MAIN_VITE_UPDATE_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
