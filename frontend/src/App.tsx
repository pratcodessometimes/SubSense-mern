import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { AiInsights } from '@/pages/AiInsights'
import { Alerts } from '@/pages/Alerts'
import { Analysis } from '@/pages/Analysis'
import { Analytics } from '@/pages/Analytics'
import { Dashboard } from '@/pages/Dashboard'
import { Login } from '@/pages/Login'
import { Settings } from '@/pages/Settings'
import { SubscriptionDetail } from '@/pages/SubscriptionDetail'
import { Subscriptions } from '@/pages/Subscriptions'
import { Transactions } from '@/pages/Transactions'
import { UploadTransactions } from '@/pages/UploadTransactions'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />

      <Route element={<AppShell />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/upload" element={<UploadTransactions />} />
        <Route path="/analysis" element={<Analysis />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/subscriptions/:id" element={<SubscriptionDetail />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/insights" element={<AiInsights />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
