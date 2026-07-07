import { IconBrandReddit, IconGlobe, IconSchool } from '@tabler/icons-react'

import { SourceMode } from '@/lib/types/search'

export interface SourceModeConfig {
  value: SourceMode
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  color: string
}

export const SOURCE_MODE_CONFIGS: SourceModeConfig[] = [
  {
    value: 'web',
    label: 'Web',
    description: 'Search the open web for current information',
    icon: IconGlobe,
    color: 'text-sky-500'
  },
  {
    value: 'academic',
    label: 'Academic',
    description: 'Scholarly sources: arXiv, Google Scholar, PubMed',
    icon: IconSchool,
    color: 'text-emerald-500'
  },
  {
    value: 'social',
    label: 'Social',
    description: 'Community discussions on Reddit',
    icon: IconBrandReddit,
    color: 'text-orange-500'
  }
]
