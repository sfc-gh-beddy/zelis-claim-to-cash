import type { Metadata } from "next"
import type React from "react"
import { AppHeader } from "@/components/app-header"
import { ThemeProvider } from "@/components/theme-provider"
import { QueryProvider } from "@/components/query-provider"
import { APP_TITLE, LOGO_SRC } from "@/lib/constants"
import "./globals.css"

export const metadata: Metadata = {
  title: APP_TITLE,
  description: "Same-day claim pricing, payment integrity and payment release on Snowflake: deterministic straight-through " +
    "processing with Cortex Agents working the exception queue under human approval.",
  icons: { icon: LOGO_SRC },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-muted/30 antialiased">
        <ThemeProvider>
          <QueryProvider>
            <AppHeader />
            {children}
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
