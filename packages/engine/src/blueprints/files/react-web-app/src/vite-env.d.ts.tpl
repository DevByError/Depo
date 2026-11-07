/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the API is when it is not behind the dev server's /api proxy, e.g. https://api.example.com */
  readonly VITE_API_URL?: string;
}
