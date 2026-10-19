import { Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { useAuth } from '@/lib/authContext'

function Row({ label, control }: { label: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-sm text-ink">{label}</span>
      {control}
    </div>
  )
}

function SectionTitle({ title, comingSoon = false }: { title: string; comingSoon?: boolean }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      {comingSoon && <Badge>Coming soon</Badge>}
    </div>
  )
}

function UnavailableButton({ label, tone = 'primary' }: { label: string; tone?: 'primary' | 'danger' }) {
  return (
    <button
      type="button"
      disabled
      title="Not available yet"
      className={`text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${tone === 'danger' ? 'text-danger' : 'text-primary'}`}
    >
      {label}
    </button>
  )
}

export function Settings() {
  const { user, logout } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    setLoggingOut(true)
    await logout()
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-[32px] font-bold text-ink">Settings</h1>

      <Card>
        <SectionTitle title="Profile" />
        <div className="divide-y divide-border/60">
          <Row label="Name" control={<span className="text-sm text-ink-muted">{user?.name}</span>} />
          <Row label="Email" control={<span className="text-sm text-ink-muted">{user?.email}</span>} />
          {user?.createdAt && (
            <Row
              label="Member since"
              control={
                <span className="text-sm text-ink-muted">
                  {new Date(user.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              }
            />
          )}
        </div>
      </Card>

      <Card>
        <SectionTitle title="Preferences" comingSoon />
        <div className="divide-y divide-border/60">
          <Row label="Currency" control={<span className="text-sm text-ink-muted">INR</span>} />
          <Row label="Date format" control={<span className="text-sm text-ink-muted">DD/MM/YYYY</span>} />
        </div>
      </Card>

      <Card>
        <SectionTitle title="Notifications" comingSoon />
        <div className="divide-y divide-border/60">
          <Row label="Price increase alerts" control={<Switch defaultChecked disabled />} />
          <Row label="Unused subscription alerts" control={<Switch defaultChecked disabled />} />
          <Row label="Weekly insights" control={<Switch defaultChecked disabled />} />
        </div>
      </Card>

      <Card>
        <SectionTitle title="Data" comingSoon />
        <div className="divide-y divide-border/60">
          <Row label="Transaction history" control={<UnavailableButton label="Export" />} />
          <Row label="Delete imported data" control={<UnavailableButton label="Delete" tone="danger" />} />
        </div>
      </Card>

      <Card>
        <SectionTitle title="Security" />
        <div className="divide-y divide-border/60">
          <Row
            label="Change password"
            control={
              <span className="flex items-center gap-2">
                <Badge>Coming soon</Badge>
                <UnavailableButton label="Change" />
              </span>
            }
          />
          <Row
            label="Log out of this device"
            control={
              <button
                type="button"
                onClick={handleLogout}
                disabled={loggingOut}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-danger disabled:opacity-60"
              >
                {loggingOut && <Loader2 size={14} className="animate-spin" />}
                {loggingOut ? 'Logging out…' : 'Logout'}
              </button>
            }
          />
        </div>
      </Card>
    </div>
  )
}
