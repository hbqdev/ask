import { IconGlobe, IconMessages, IconSchool } from '@tabler/icons-react'

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
    description:
      'Scholarly sources: arXiv, Google Scholar, PubMed, Semantic Scholar',
    icon: IconSchool,
    color: 'text-emerald-500'
  },
  {
    value: 'social',
    label: 'Social Media',
    description: 'Community discussions: Reddit, Lemmy, Mastodon, Hacker News',
    icon: IconMessages,
    color: 'text-orange-500'
  }
]
