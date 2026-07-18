import './globals.css'
import { Toaster } from 'sonner'

export const metadata = { title: 'Ask Model Manager' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  )
}
