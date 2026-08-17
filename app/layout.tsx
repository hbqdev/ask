import type { Metadata, Viewport } from 'next'

import { countChats, getRecentChats } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { ChatHeaderProvider } from '@/lib/contexts/chat-header-context'
import { UserProvider } from '@/lib/contexts/user-context'
import { hasSupabasePublicConfig } from '@/lib/supabase/keys'
import { createClient } from '@/lib/supabase/server'

import { SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'

import AppSidebar from '@/components/app-sidebar'
import ArtifactRoot from '@/components/artifact/artifact-root'
import Header from '@/components/header'
import { KeyboardShortcutHandler } from '@/components/keyboard-shortcut-handler'
import { LibraryProvider } from '@/components/library/library-context'
import { PostHogProvider } from '@/components/posthog-provider'
import { ThemeProvider } from '@/components/theme-provider'

import './globals.css'

const title = 'Ask'
const description =
  'A fully open-source AI-powered answer engine with a generative UI.'

export const metadata: Metadata = {
  metadataBase: new URL('https://ask.hbqnexus.win'),
  title,
  description,
  openGraph: {
    title,
    description
  },
  twitter: {
    title,
    description,
    card: 'summary_large_image'
  }
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1
}

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode
}>) {
  let user = null

  if (hasSupabasePublicConfig()) {
    const supabase = await createClient()
    const {
      data: { user: supabaseUser }
    } = await supabase.auth.getUser()
    user = supabaseUser
  }

  const userId = user?.id ?? (await getCurrentUserId())

  // Server-render the sidebar's Recent list + real chat count. Fail-open: any
  // read error yields an empty list / zero rather than crashing the layout.
  // A client island in AppSidebar refreshes these on chat create/delete/rename.
  let recentChats: Awaited<ReturnType<typeof getRecentChats>> = []
  let chatCount = 0
  if (userId) {
    try {
      // Settle the two reads independently so a count failure can't discard a
      // successfully-fetched Recent list (and vice versa). `countChats`
      // (`countUserChats`) is deliberately a throwing primitive — the fallback
      // lives here at the call site, not in the DB layer.
      ;[recentChats, chatCount] = await Promise.all([
        getRecentChats(10).catch(() => []),
        countChats().catch(() => 0)
      ])
    } catch (error) {
      console.error('Failed to load sidebar chat data (non-fatal):', error)
    }
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="fixed inset-0 flex flex-col font-sans antialiased overflow-hidden">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <PostHogProvider userId={user?.id ?? null}>
            <UserProvider hasUser={!!userId}>
              <SidebarProvider
                defaultOpen={true}
                style={
                  {
                    '--sidebar-width': '16rem',
                    '--sidebar-width-icon': '80px'
                  } as React.CSSProperties
                }
              >
                <LibraryProvider>
                  {userId && (
                    <AppSidebar
                      user={user}
                      recentChats={recentChats}
                      chatCount={chatCount}
                    />
                  )}
                  <KeyboardShortcutHandler />
                  <ChatHeaderProvider>
                    <div className="flex flex-col flex-1 min-w-0">
                      <Header showGuestMenu={!userId} />
                      <main className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
                        <ArtifactRoot>{children}</ArtifactRoot>
                      </main>
                    </div>
                  </ChatHeaderProvider>
                </LibraryProvider>
              </SidebarProvider>
            </UserProvider>
          </PostHogProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
