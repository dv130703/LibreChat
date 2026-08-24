import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// One typeface for the whole interface - headings, body and figures alike.
// Self-hosted rather than pulled from a CDN, so the app keeps its typography
// offline and behind the same origin as everything else. The variable axis
// covers 300-900, so every weight the UI asks for comes from this one file.
import '@fontsource-variable/inter'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
