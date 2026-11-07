import { useState, type FormEvent } from 'react'
import { BrandFigure } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Shown instead of the app when the host has sign-in on and there is no session. */
export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (res.ok) return onSignedIn()
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? `Sign-in failed (${res.status})`)
    } catch {
      setError("Can't reach SparkMan.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5 rounded-xl border bg-card p-6 shadow-sm" data-testid="login-form">
        <div className="flex items-center gap-4">
          <BrandFigure className="h-16 w-auto shrink-0" alt="" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">SparkMan</h1>
            <p className="text-sm text-muted-foreground">Sign in to the fleet console.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="login-user">Username</Label>
          <Input id="login-user" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="login-pass">Password</Label>
          <Input id="login-pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-level-error">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  )
}

export interface SessionInfo {
  authEnabled: boolean
  user: string | null
}

export async function getSession(): Promise<SessionInfo> {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' })
    if (res.ok) return (await res.json()) as SessionInfo
  } catch {
    // dev without the host server: no sign-in
  }
  return { authEnabled: false, user: null }
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined)
  window.location.reload()
}
