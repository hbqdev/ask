// The composer's options: search mode, sources and the answering model.
// Mode and sources belong to the caller (they ride on each chat request);
// the model is the signed-in user's saved preference on the server, which
// ModelPicker loads and saves itself.

import { Sheet } from '@/core/ui/Sheet'
import { ModelPicker } from '@/features/compose/ModelPicker'
import {
  SearchModeField,
  SourcesField
} from '@/features/compose/SearchOptionFields'
import type { SearchSettings } from '@/features/thread/chat-body'

export type OptionsSheetProps = {
  open: boolean
  onClose: () => void
  settings: SearchSettings
  onSettings: (settings: SearchSettings) => void
}

/**
 * The sheet mounts its content only while open, so each opening loads the
 * model list afresh and starts with no old error.
 */
export function OptionsSheet({
  open,
  onClose,
  settings,
  onSettings
}: OptionsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Options">
      <div className="flex flex-col gap-6 pb-2">
        <SearchModeField settings={settings} onSettings={onSettings} />
        <SourcesField settings={settings} onSettings={onSettings} />
        {/* A long list would hide the pick below the sheet's fold. */}
        <ModelPicker revealChecked />
      </div>
    </Sheet>
  )
}
