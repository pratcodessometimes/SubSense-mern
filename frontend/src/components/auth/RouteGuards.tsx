import { Loader2, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { safeRedirectTarget, useAuth, type RedirectState } from '@/lib/authContext'

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-canvas px-6">{children}</div>
}

function AuthPending() {
  const { status, retry } = useAuth()
  if (status === 'error') {
    return (
      <FullScreen>
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <WifiOff size={28} className="text-ink-muted" />
          <p className="text-sm text-ink">We couldn't reach the SubSense server to check your session.</p>
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      </FullScreen>
    )
  }
  return (
    <FullScreen>
      <div role="status" className="flex items-center gap-2 text-sm text-ink-muted">
        <Loader2 size={18} className="animate-spin text-primary" />
        Checking your session…
      </div>
    </FullScreen>
  )
}

/** Renders private pages only for an authenticated session; never flashes them while unresolved. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading' || status === 'error') return <AuthPending />
  if (status === 'unauthenticated') {
    const from = `${location.pathname}${location.search}${location.hash}`
    return <Navigate to="/" replace state={{ from } satisfies RedirectState} />
  }
  return <>{children}</>
}

/** Login/registration page: already-authenticated users go to where they were heading. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading' || status === 'error') return <AuthPending />
  if (status === 'authenticated') {
    return <Navigate to={safeRedirectTarget((location.state as RedirectState | null)?.from)} replace />
  }
  return <>{children}</>
}
