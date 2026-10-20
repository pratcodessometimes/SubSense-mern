import { Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/authContext'
import { Header } from './Header'
import { Sidebar } from './Sidebar'

export function AppShell() {
  const { user } = useAuth()

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 overflow-y-auto px-8 py-7">
          {/* Keyed by user so no page state can carry over between accounts. */}
          <Outlet key={user?.id} />
        </main>
      </div>
    </div>
  )
}
