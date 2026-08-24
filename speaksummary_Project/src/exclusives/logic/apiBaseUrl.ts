// Shared by every backend API client (transcribe, summarize, audio quality).
//
// Empty string = same origin as the page, so requests go to `/api/...` and are
// forwarded to the backend by the dev-server proxy in vite.config.ts. That
// keeps it working no matter which host the UI is opened on (localhost, the
// LAN IP from `vite --host`, a tunnel) and avoids CORS entirely.
// Set VITE_API_BASE_URL to an absolute URL when the frontend is served
// somewhere that can't proxy to the backend (e.g. a static production build).
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
