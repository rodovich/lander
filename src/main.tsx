import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './errorBoundary'
import './styles.css'

if (import.meta.env.DEV) {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="lander">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
