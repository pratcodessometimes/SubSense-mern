import { Check, Loader2, Pencil } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { FocusSelector } from '@/components/insights/FocusSelector'
import { ALERT_CATEGORIES, type AlertCategory } from '@/lib/alertPreferences'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/lib/authContext'

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3">
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="text-xs text-ink-muted">{hint}</div>}
      </div>
      <div className="max-w-full min-w-0 break-words">{control}</div>
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

// Same rules as the server (which stays authoritative). Matching control characters is the point.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/
function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required'
  if (CONTROL_CHARS.test(trimmed)) return 'Name contains invalid characters'
  if (trimmed.replace(/\s+/g, ' ').length > 80) return 'Name must be at most 80 characters'
  return null
}

function ProfileCard() {
  const { user, updateProfile } = useAuth()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  function startEditing() {
    setDraft(user?.name ?? '')
    setError(null)
    setSaved(false)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setError(null)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const validation = validateName(draft)
    if (validation) return setError(validation)
    setSaving(true)
    setError(null)
    try {
      await updateProfile(draft)
      setEditing(false)
      setSaved(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your name. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const unchanged = draft.trim().replace(/\s+/g, ' ') === user?.name

  return (
    <Card>
      <SectionTitle title="Profile" />
      <div className="divide-y divide-border/60">
        {editing ? (
          <form onSubmit={save} noValidate className="flex flex-col gap-2 py-3">
            <label htmlFor="profile-name" className="text-sm text-ink">
              Name
            </label>
            <input
              id="profile-name"
              autoFocus
              autoComplete="name"
              maxLength={120}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setError(null)
              }}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'profile-name-error' : undefined}
              className={`rounded-lg border bg-canvas px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 ${
                error ? 'border-danger focus:ring-danger-tint' : 'border-border focus:border-primary focus:ring-primary-tint'
              }`}
            />
            {error && (
              <p id="profile-name-error" role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || unchanged}
                icon={saving ? <Loader2 size={16} className="animate-spin" /> : undefined}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        ) : (
          <Row
            label="Name"
            control={
              <span className="flex items-center gap-3">
                <span className="text-sm text-ink-muted">{user?.name}</span>
                <button
                  type="button"
                  onClick={startEditing}
                  className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:text-primary-hover"
                >
                  <Pencil size={14} /> Edit
                </button>
              </span>
            }
          />
        )}
        <Row label="Email" hint="Your sign-in email can't be changed yet" control={<span className="break-all text-sm text-ink-muted">{user?.email}</span>} />
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
      {saved && !editing && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-sm text-positive">
          <Check size={15} /> Name updated
        </p>
      )}
    </Card>
  )
}

function AlertVisibilityCard() {
  const { user, updatePreferences } = useAuth()
  const [pending, setPending] = useState<Partial<Record<AlertCategory, boolean>>>({})
  const [error, setError] = useState<string | null>(null)
  const prefs = user?.preferences.alerts

  // The switch only changes once the server confirms, so the UI never shows an unsaved state as saved.
  async function toggle(key: AlertCategory, next: boolean) {
    setPending((p) => ({ ...p, [key]: true }))
    setError(null)
    try {
      await updatePreferences({ alerts: { [key]: next } })
    } catch (err) {
      const label = ALERT_CATEGORIES.find((c) => c.key === key)?.label.toLowerCase() ?? 'this preference'
      setError(
        `Couldn't save ${label}. Your previous setting is still in effect.${err instanceof ApiError ? ` (${err.message})` : ''}`,
      )
    } finally {
      setPending((p) => ({ ...p, [key]: false }))
    }
  }

  return (
    <Card>
      <SectionTitle title="Alert visibility" />
      <p className="text-sm text-ink-muted">
        Choose which alert categories appear in SubSense. Detection keeps running for every category, and hidden alerts
        come back as soon as you turn a category on again.
      </p>
      <div className="mt-2 divide-y divide-border/60">
        {ALERT_CATEGORIES.map(({ key, label, description }) => (
          <Row
            key={key}
            label={label}
            hint={description}
            control={
              <span className="flex items-center gap-2">
                {pending[key] && <Loader2 size={14} className="animate-spin text-ink-muted" aria-label="Saving" />}
                <Switch
                  label={label}
                  checked={prefs?.[key] ?? true}
                  disabled={!prefs || Boolean(pending[key])}
                  onChange={(next) => toggle(key, next)}
                />
              </span>
            }
          />
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  )
}

export function Settings() {
  const { logout } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    setLoggingOut(true)
    await logout()
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-[28px] font-bold text-ink sm:text-[32px]">Settings</h1>

      <ProfileCard />

      <AlertVisibilityCard />

      <Card>
        <SectionTitle title="Recommendation focus" />
        <p className="mb-3 text-sm text-ink-muted">
          Choose what SubSense should rank first on your Insights page. This changes the order only — never the amounts or the
          evidence behind a recommendation.
        </p>
        <FocusSelector />
      </Card>

      <Card>
        <SectionTitle title="Email & push notifications" comingSoon />
        <div className="divide-y divide-border/60">
          <Row label="Weekly insights email" control={<Switch disabled label="Weekly insights email" />} />
        </div>
      </Card>

      <Card>
        <SectionTitle title="Regional" />
        <div className="divide-y divide-border/60">
          <Row label="Currency" hint="INR is currently the only supported currency" control={<span className="text-sm text-ink-muted">INR (₹)</span>} />
          <Row label="Date format" control={<span className="text-sm text-ink-muted">DD/MM/YYYY</span>} />
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
