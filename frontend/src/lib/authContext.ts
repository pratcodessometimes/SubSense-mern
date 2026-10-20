import { createContext, useContext } from 'react'
import type { AuthUser, PreferencesUpdate } from './api'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error'

export interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  retry: () => void
  /** Saves the display name and updates every consumer (Header, Dashboard, ...) immediately. */
  updateProfile: (name: string) => Promise<void>
  /** Persists alert visibility / recommendation focus; local state changes only after the server confirms. */
  updatePreferences: (update: PreferencesUpdate) => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/** Router state set when a private page redirects to the login page. */
export interface RedirectState {
  from?: string
}

/** Only same-app paths are allowed as post-login targets (no open redirects). */
export function safeRedirectTarget(from: string | undefined) {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from === '/') return '/dashboard'
  return from
}
