import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EmbedTask } from './embed'
import { ErrorBoundary } from './errorBoundary'
import { taskRefFromQuery } from './taskRef'
import './styles.css'

const taskRef = taskRefFromQuery(window.location.search)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="lander">
      {taskRef ? (
        <EmbedTask taskRef={taskRef} />
      ) : (
        <div className="placeholder">No task named</div>
      )}
    </ErrorBoundary>
  </StrictMode>,
)
