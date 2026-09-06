import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'

function Row({ label, control }: { label: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-sm text-ink">{label}</span>
      {control}
    </div>
  )
}

export function Settings() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-[32px] font-bold text-ink">Settings</h1>

      <Card>
        <h2 className="mb-1 text-xl font-semibold text-ink">Profile</h2>
        <div className="divide-y divide-border/60">
          <Row label="Name" control={<span className="text-sm text-ink-muted">Vedant</span>} />
          <Row
            label="Email"
            control={<span className="text-sm text-ink-muted">vedant@example.com</span>}
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-xl font-semibold text-ink">Preferences</h2>
        <div className="divide-y divide-border/60">
          <Row label="Currency" control={<span className="text-sm text-ink-muted">INR</span>} />
          <Row label="Date format" control={<span className="text-sm text-ink-muted">DD/MM/YYYY</span>} />
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-xl font-semibold text-ink">Notifications</h2>
        <div className="divide-y divide-border/60">
          <Row label="Price increase alerts" control={<Switch defaultChecked />} />
          <Row label="Unused subscription alerts" control={<Switch defaultChecked />} />
          <Row label="Weekly insights" control={<Switch defaultChecked />} />
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-xl font-semibold text-ink">Data</h2>
        <div className="divide-y divide-border/60">
          <Row
            label="Transaction history"
            control={<button className="text-sm font-semibold text-primary">Export</button>}
          />
          <Row
            label="Delete imported data"
            control={<button className="text-sm font-semibold text-danger">Delete</button>}
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-xl font-semibold text-ink">Security</h2>
        <div className="divide-y divide-border/60">
          <Row
            label="Change password"
            control={<button className="text-sm font-semibold text-primary">Change</button>}
          />
          <Row label="Logout" control={<button className="text-sm font-semibold text-danger">Logout</button>} />
        </div>
      </Card>
    </div>
  )
}
