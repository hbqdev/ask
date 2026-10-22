// Today, for lists that show dates by the day (the Library's rows and date
// sections): a Date at today's local midnight, the same object all day. It
// moves to the new day when the app comes back to the foreground on another
// day, or when the list renders for another reason on another day.

import { App } from '@capacitor/app'
import { useEffect, useMemo, useState } from 'react'

/** Today's local midnight (ms): it changes once a day. */
function startOfToday() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export function useToday(): Date {
  const [, setDay] = useState(startOfToday)
  useEffect(() => {
    const handle = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) setDay(startOfToday())
    })
    return () => {
      void handle.then(h => h.remove())
    }
  }, [])
  const today = startOfToday()
  return useMemo(() => new Date(today), [today])
}
