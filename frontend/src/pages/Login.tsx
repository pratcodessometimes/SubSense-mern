import { AlertTriangle, ArrowRight, Eye, EyeOff, Loader2, Wallet } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { clsx } from 'clsx'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/lib/authContext'
import { formatCurrency } from '@/lib/format'
import { kpis } from '@/lib/mockData'

type Mode = 'signin' | 'register'
type Field = 'name' | 'email' | 'password'
type FieldErrors = Partial<Record<Field, string>>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Mirrors the server rules so most mistakes are caught before a round trip;
// the server remains the authority and its messages are shown as-is.
function validate(mode: Mode, name: string, email: string, password: string): FieldErrors {
  const errors: FieldErrors = {}
  if (mode === 'register') {
    if (!name.trim()) errors.name = 'Name is required'
    else if (name.trim().length > 80) errors.name = 'Name must be at most 80 characters'
  }
  if (!email.trim()) errors.email = 'Email is required'
  else if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address'
  if (!password) errors.password = 'Password is required'
  else if (mode === 'register') {
    if (password.length < 8) errors.password = 'Password must be at least 8 characters'
    else if (password.length > 128) errors.password = 'Password must be at most 128 characters'
    else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      errors.password = 'Password must contain at least one letter and one number'
    }
  }
  return errors
}

const inputClass = (invalid: boolean) =>
  clsx(
    'w-full rounded-lg border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2',
    invalid
      ? 'border-danger focus:border-danger focus:ring-danger-tint'
      : 'border-border focus:border-primary focus:ring-primary-tint',
  )

export function Login() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<Mode>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function switchMode(next: Mode) {
    setMode(next)
    setFieldErrors({})
    setFormError(null)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const errors = validate(mode, name, email, password)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSubmitting(true)
    try {
      // On success the auth state flips to authenticated and the route guard redirects.
      if (mode === 'signin') await login(email.trim(), password)
      else await register(name.trim(), email.trim(), password)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields as FieldErrors)
        setFormError(
          err.status === 429
            ? 'Too many attempts. Please wait a few minutes and try again.'
            : err.message,
        )
      } else {
        setFormError('Could not reach the SubSense server. Check your connection and try again.')
      }
      setSubmitting(false)
    }
  }

  const isRegister = mode === 'register'

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-16 lg:px-20">
        <div className="mb-10 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white">
            <Wallet size={20} />
          </div>
          <span className="text-xl font-bold text-ink">SubSense</span>
        </div>

        <h1 className="max-w-md text-[32px] font-bold leading-tight text-ink">
          Know where your recurring money goes.
        </h1>
        <p className="mt-4 max-w-md text-base leading-relaxed text-ink-muted">
          Automatically detect subscriptions, spot hidden price increases, and understand your
          recurring spending — grounded in your real transaction data, not guesswork.
        </p>

        <Card className="mt-8 w-full max-w-md">
          <div role="tablist" aria-label="Authentication" className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-canvas p-1">
            {(['signin', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={clsx(
                  'rounded-md py-2 text-sm font-semibold transition-colors',
                  mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                )}
              >
                {m === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            {isRegister && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-ink-muted" htmlFor="auth-name">
                  Name
                </label>
                <input
                  id="auth-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={Boolean(fieldErrors.name)}
                  aria-describedby={fieldErrors.name ? 'auth-name-error' : undefined}
                  className={inputClass(Boolean(fieldErrors.name))}
                />
                {fieldErrors.name && (
                  <p id="auth-name-error" className="text-xs text-danger">
                    {fieldErrors.name}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-ink-muted" htmlFor="auth-email">
                Email
              </label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? 'auth-email-error' : undefined}
                className={inputClass(Boolean(fieldErrors.email))}
              />
              {fieldErrors.email && (
                <p id="auth-email-error" className="text-xs text-danger">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-ink-muted" htmlFor="auth-password">
                Password
              </label>
              <div className="relative">
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={Boolean(fieldErrors.password)}
                  aria-describedby={fieldErrors.password ? 'auth-password-error' : isRegister ? 'auth-password-hint' : undefined}
                  className={clsx(inputClass(Boolean(fieldErrors.password)), 'pr-10')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted hover:bg-surface hover:text-ink"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {fieldErrors.password ? (
                <p id="auth-password-error" className="text-xs text-danger">
                  {fieldErrors.password}
                </p>
              ) : (
                isRegister && (
                  <p id="auth-password-hint" className="text-xs text-ink-muted">
                    At least 8 characters, including a letter and a number.
                  </p>
                )
              )}
            </div>

            {formError && (
              <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            )}

            <Button
              type="submit"
              disabled={submitting}
              icon={submitting ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              className="mt-1"
            >
              {submitting
                ? isRegister
                  ? 'Creating account…'
                  : 'Signing in…'
                : isRegister
                  ? 'Create account'
                  : 'Sign in'}
            </Button>
          </form>
        </Card>
      </div>

      <div className="hidden items-center justify-center bg-ink px-16 py-16 lg:flex">
        <div className="w-full max-w-sm">
          <Card className="bg-surface/95 backdrop-blur">
            <span className="text-sm font-medium text-ink-muted">Monthly recurring spend</span>
            <div className="mt-2 text-[36px] font-bold leading-none text-ink">
              {formatCurrency(kpis.monthlySpend)}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-canvas p-3">
                <div className="text-xl font-bold text-ink">{kpis.activeSubscriptions}</div>
                <div className="text-xs text-ink-muted">subscriptions</div>
              </div>
              <div className="rounded-xl bg-danger-tint p-3">
                <div className="flex items-center gap-1 text-xl font-bold text-danger">
                  <AlertTriangle size={16} />
                  {kpis.alertCount}
                </div>
                <div className="text-xs text-danger/80">alerts</div>
              </div>
            </div>
          </Card>
          <p className="mt-3 text-center text-xs text-white/60">Example preview — sample data</p>
        </div>
      </div>
    </div>
  )
}
