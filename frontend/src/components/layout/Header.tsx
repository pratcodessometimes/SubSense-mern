import { Bell, Loader2, LogOut, Search, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/lib/authContext'

export function Header() {
  const { user, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [menuOpen])

  async function handleLogout() {
    setLoggingOut(true)
    await logout()
  }

  const initial = user?.name.trim().charAt(0).toUpperCase() || '?'

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-8">
      <div className="relative w-80">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
        <input
          type="text"
          disabled
          title="Search is not available yet"
          placeholder="Search (coming soon)"
          className="w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint disabled:cursor-not-allowed"
        />
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          disabled
          title="Notifications are not available yet"
          aria-label="Notifications (coming soon)"
          className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Bell size={18} />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Account menu for ${user?.name ?? 'user'}`}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary-tint"
          >
            {initial}
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-border bg-surface p-2 shadow-[var(--shadow-card-soft)]"
            >
              <div className="border-b border-border/60 px-3 pb-3 pt-1">
                <div className="truncate text-sm font-semibold text-ink">{user?.name}</div>
                <div className="truncate text-xs text-ink-muted">{user?.email}</div>
              </div>
              <Link
                to="/settings"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink hover:bg-canvas"
              >
                <SettingsIcon size={16} className="text-ink-muted" />
                Settings
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={handleLogout}
                disabled={loggingOut}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger-tint disabled:opacity-60"
              >
                {loggingOut ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}
                {loggingOut ? 'Logging out…' : 'Log out'}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
