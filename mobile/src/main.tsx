import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import { armSplashFailsafe } from '@/app/splash'
import { watchTextSize } from '@/core/text-size'

import './styles.css'

// Before React: even a crash in the first render cannot keep the native
// splash up for good (the app hides it itself; see src/app/splash.ts).
armSplashFailsafe()

// The root font size follows the iOS text size before the first paint, so
// the app never renders at one size and then jumps (src/core/text-size.ts).
watchTextSize()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
