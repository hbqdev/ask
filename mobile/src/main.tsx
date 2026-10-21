import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import { armSplashFailsafe } from '@/app/splash'

import './styles.css'

// Before React: even a crash in the first render cannot keep the native
// splash up for good (the app hides it itself; see src/app/splash.ts).
armSplashFailsafe()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
