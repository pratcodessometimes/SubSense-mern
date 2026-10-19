import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '@/lib/api'
import { AuthContext, type AuthContextValue, type AuthStatus } from '@/lib/authContext'

/**
 * Restores the session from the HttpOnly cookie on load (GET /auth/me) and exposes
 * login / register / logout. No credential or token is ever persisted in the browser.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<api.AuthUser | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    api
      .getCurrentUser()
      .then((current) => {
        if (cancelled) return
        setUser(current)
        setStatus(current ? 'authenticated' : 'unauthenticated')
      })
      .catch(() => {
        if (!cancelled) setStatus('error') // server unreachable: neither show private pages nor claim logged-out
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  // Any private request that comes back 401 (expired or revoked session) signs the UI out;
  // the route guard then redirects to the login page.
  useEffect(() => {
    api.onUnauthorized(() => {
      api.setCsrfToken(null)
      setUser(null)
      setStatus('unauthenticated')
    })
    return () => api.onUnauthorized(null)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const next = await api.login(email, password)
    setUser(next)
    setStatus('authenticated')
  }, [])

  const register = useCallback(async (name: string, email: string, password: string) => {
    const next = await api.register(name, email, password)
    setUser(next)
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // Already expired/revoked server-side; clear the local state regardless.
    }
    setUser(null)
    setStatus('unauthenticated')
  }, [])

  const updateProfile = useCallback(async (name: string) => {
    setUser(await api.updateProfile(name))
  }, [])

  const updatePreferences = useCallback(async (alerts: Partial<api.AlertPreferences>) => {
    const preferences = await api.updatePreferences(alerts)
    setUser((current) => (current ? { ...current, preferences } : current))
  }, [])

  const retry = useCallback(() => {
    setStatus('loading')
    setAttempt((n) => n + 1)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, register, logout, retry, updateProfile, updatePreferences }),
    [status, user, login, register, logout, retry, updateProfile, updatePreferences],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
