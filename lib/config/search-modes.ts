import {
  IconAdjustmentsHorizontal,
  IconBolt,
  IconStars
} from '@tabler/icons-react'

import { SearchMode } from '@/lib/types/search'

export interface SearchModeConfig {
  value: SearchMode
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  color: string
}

// Centralized search mode configuration
export const SEARCH_MODE_CONFIGS: SearchModeConfig[] = [
  {
    value: 'speed',
    label: 'Speed',
    description:
      'Fast answers from a single web pass — usually ~5–10s. Best for quick lookups and current events.',
    icon: IconBolt,
    color: 'text-amber-500'
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description:
      'Multi-source research with citations — usually ~15–30s. Best for most questions.',
    icon: IconAdjustmentsHorizontal,
    color: 'text-violet-500'
  },
  {
    value: 'quality',
    label: 'Quality',
    description:
      'Deep research across the most sources, with page crawling — usually ~45s or more. Best for complex, research-heavy questions.',
    icon: IconStars,
    color: 'text-blue-500'
  }
]

// Helper function to get a specific mode config
export function getSearchModeConfig(
  mode: SearchMode
): SearchModeConfig | undefined {
  return SEARCH_MODE_CONFIGS.find(config => config.value === mode)
}
