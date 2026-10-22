"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { APP_TITLE, LOGO_SRC, NAV } from "@/lib/constants"
import { ThemeToggle } from "@/components/theme-toggle"
import { PersonaSwitcher } from "@/components/persona-switcher"
import { cn } from "@/lib/utils"

export function AppHeader() {
  const path = usePathname()
  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-[var(--brand-nav-bg)] text-[var(--brand-nav-fg)]">
      <div className="flex h-14 w-full items-center gap-4 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Image src={LOGO_SRC} alt="" width={28} height={28} />
          <span className="text-sm font-semibold tracking-tight">{APP_TITLE}</span>
        </Link>
        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Main">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href)
            return (
              <Link key={n.href} href={n.href}
                className={cn("whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  active ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10 hover:text-white")}>
                {n.label}
              </Link>
            )
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <PersonaSwitcher />
          <span className="hidden rounded border border-amber-300/40 bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200 lg:inline">
            Synthetic data
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
