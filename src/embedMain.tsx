import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EmbedPreview, EmbedTask } from './embed'
import { ErrorBoundary } from './errorBoundary'
import { taskRefFromQuery } from './taskRef'
import { PREVIEW_PARAM } from '../widget/messages'
import './styles.css'

const taskRef = taskRefFromQuery(window.location.search)
const preview = new URLSearchParams(window.location.search).has(PREVIEW_PARAM)
// The app's page shows through around the preview.
if (preview) document.body.classList.add('embed-preview-page')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="lander">
      {!taskRef ? (
        <div className="placeholder">No task named</div>
      ) : preview ? (
        <EmbedPreview projectSlug={taskRef.projectSlug} />
      ) : (
        <EmbedTask taskRef={taskRef} />
      )}
    </ErrorBoundary>
  </StrictMode>,
)
