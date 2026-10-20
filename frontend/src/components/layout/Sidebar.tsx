import {
  Bell,
  LayoutGrid,
  LineChart,
  Repeat,
  Settings as SettingsIcon,
  Sparkles,
  ArrowLeftRight,
  Wallet,
  X,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { clsx } from 'clsx'

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
  { to: '/subscriptions', label: 'Subscriptions', icon: Repeat },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { to: '/analytics', label: 'Analytics', icon: LineChart },
  { to: '/insights', label: 'AI Insights', icon: Sparkles },
  { to: '/alerts', label: 'Alerts', icon: Bell },
]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    isActive ? 'bg-primary-tint text-primary' : 'text-ink-muted hover:bg-canvas hover:text-ink',
  )

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white">
        <Wallet size={18} aria-hidden="true" />
      </div>
      <span className="text-lg font-bold text-ink">SubSense</span>
    </div>
  )
}

/** Navigation links shared by the desktop sidebar and the mobile drawer. */
function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={linkClass} onClick={onNavigate}>
            <Icon size={18} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border pt-3">
        <NavLink to="/settings" className={linkClass} onClick={onNavigate}>
          <SettingsIcon size={18} aria-hidden="true" />
          Settings
        </NavLink>
      </div>
    </>
  )
}

/** Fixed 240 px sidebar, shown from the lg breakpoint (1024 px) up. */
export function Sidebar() {
  return (
    <aside className="hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface px-4 py-6 lg:flex">
      <div className="mb-8">
        <Brand />
      </div>
      <NavContent />
    </aside>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Phase 5.1: modal navigation drawer for viewports below 1024 px. Focus moves into the drawer
 * and is kept there while it is open; Escape, the backdrop, the close button and choosing a
 * destination all close it, and focus then returns to the menu button (handled by the caller).
 */
export function MobileNav({ open, onClose, id }: { open: boolean; onClose: () => void; id: string }) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    // Start on the current page's link, so keyboard users keep their place.
    const initial = panel?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
    initial?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="absolute inset-0 bg-ink/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-surface px-4 py-5 shadow-xl"
      >
        <div className="mb-6 flex items-center justify-between">
          <Brand />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted hover:bg-canvas hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <NavContent onNavigate={onClose} />
      </div>
    </div>
  )
}
