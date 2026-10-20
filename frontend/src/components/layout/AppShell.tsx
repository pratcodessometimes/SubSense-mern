import { useCallback, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/authContext'
import { Header } from './Header'
import { MobileNav, Sidebar } from './Sidebar'

const MOBILE_NAV_ID = 'mobile-navigation'

export function AppShell() {
  const { user } = useAuth()
  const location = useLocation()
  // The drawer is open only for the page it was opened on, so any route change (link, back
  // button, redirect) closes it without an extra effect.
  const [navOpenAt, setNavOpenAt] = useState<string | null>(null)
  const navOpen = navOpenAt === location.pathname
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  const closeNav = useCallback(() => {
    setNavOpenAt(null)
    menuButtonRef.current?.focus()
  }, [])

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <Sidebar />
      <MobileNav open={navOpen} onClose={closeNav} id={MOBILE_NAV_ID} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          menuButtonRef={menuButtonRef}
          navOpen={navOpen}
          navId={MOBILE_NAV_ID}
          onOpenNav={() => setNavOpenAt(location.pathname)}
        />
        <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          {/* Keyed by user so no page state can carry over between accounts. */}
          <Outlet key={user?.id} />
        </main>
      </div>
    </div>
  )
}
