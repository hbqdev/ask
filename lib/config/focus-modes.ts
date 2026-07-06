import {
  IconBrain,
  IconBrandReddit,
  IconSchool
} from '@tabler/icons-react'

import { FocusMode } from '@/lib/types/search'

export interface FocusModeConfig {
  value: FocusMode
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  color: string
}

export const FOCUS_MODE_CONFIGS: FocusModeConfig[] = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Model picks the best sources based on your query',
    icon: IconBrain,
    color: 'text-sky-500'
  },
  {
    value: 'academic',
    label: 'Academic',
    description:
      'Forces scholarly sources: Google Scholar, arXiv, Semantic Scholar, PubMed',
    icon: IconSchool,
    color: 'text-emerald-500'
  },
  {
    value: 'discussions',
    label: 'Discussions',
    description: 'Forces community sources: Reddit opinions and experiences',
    icon: IconBrandReddit,
    color: 'text-orange-500'
  }
]

export function getFocusModeConfig(
  mode: FocusMode
): FocusModeConfig | undefined {
  return FOCUS_MODE_CONFIGS.find(config => config.value === mode)
}
