import {
  Bell,
  LayoutGrid,
  LineChart,
  Repeat,
  Settings as SettingsIcon,
  Sparkles,
  ArrowLeftRight,
  Wallet,
} from 'lucide-react'
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

export function Sidebar() {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface px-4 py-6">
      <div className="mb-8 flex items-center gap-2 px-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white">
          <Wallet size={18} />
        </div>
        <span className="text-lg font-bold text-ink">SubSense</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary-tint text-primary'
                  : 'text-ink-muted hover:bg-canvas hover:text-ink',
              )
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border pt-3">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'bg-primary-tint text-primary' : 'text-ink-muted hover:bg-canvas hover:text-ink',
            )
          }
        >
          <SettingsIcon size={18} />
          Settings
        </NavLink>
      </div>
    </aside>
  )
}
