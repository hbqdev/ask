// Haptic feedback at the app's key moments: a light tap on send, a selection
// tick on a tab or option change, a warning on a destructive step, and so on.
// It is feedback only, never needed for anything to work: a no-op on the web
// (and so in tests), fire-and-forget, and it never throws.

import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

export type HapticKind =
  | 'light'
  | 'medium'
  | 'selection'
  | 'success'
  | 'warning'
  | 'error'

const PLAY: Record<HapticKind, () => Promise<unknown>> = {
  light: () => Haptics.impact({ style: ImpactStyle.Light }),
  medium: () => Haptics.impact({ style: ImpactStyle.Medium }),
  // On iOS a selection tick needs a generator, which only selectionStart
  // makes: selectionChanged alone does nothing. selectionEnd then releases
  // it. The three calls queue in order.
  selection: () =>
    Promise.all([
      Haptics.selectionStart(),
      Haptics.selectionChanged(),
      Haptics.selectionEnd()
    ]),
  success: () => Haptics.notification({ type: NotificationType.Success }),
  warning: () => Haptics.notification({ type: NotificationType.Warning }),
  error: () => Haptics.notification({ type: NotificationType.Error })
}

/** Plays a haptic; a no-op on the web. Never waits and never throws. */
export function haptic(kind: HapticKind): void {
  if (!Capacitor.isNativePlatform()) return
  try {
    PLAY[kind]().catch(() => {})
  } catch {
    // A plugin missing from the native build throws: no haptic, nothing more.
  }
}
