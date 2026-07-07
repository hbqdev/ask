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
      'Fast answers with focused web search. Best for quick lookups and current events.',
    icon: IconBolt,
    color: 'text-amber-500'
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description:
      'Thorough research with intelligent multi-step planning. Best for most queries.',
    icon: IconAdjustmentsHorizontal,
    color: 'text-violet-500'
  },
  {
    value: 'quality',
    label: 'Quality',
    description:
      'Deep research with comprehensive coverage. Best for complex or research-heavy questions.',
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
