import { Bell, Search } from 'lucide-react'

export function Header() {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-8">
      <div className="relative w-80">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
        <input
          type="text"
          placeholder="Search subscriptions, transactions..."
          className="w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint"
        />
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-canvas hover:text-ink"
        >
          <Bell size={18} />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger" />
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
          V
        </div>
      </div>
    </header>
  )
}
