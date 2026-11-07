import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useCreateKey } from '@/api/hooks'
import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const LIMITS = [60, 120, 300, 600]

export function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateKey()
  const [name, setName] = useState('')
  const [limit, setLimit] = useState('300')
  const [secret, setSecret] = useState<string | null>(null)

  const close = () => {
    setName('')
    setLimit('300')
    setSecret(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>Copy it now and store it in your agent’s environment as SPARKMAN_API_KEY.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border bg-surface-2 px-3 py-2">
              <code className="flex-1 break-all font-mono text-sm" data-testid="new-secret">
                {secret}
              </code>
              <CopyButton value={secret} toastText="Key copied" />
            </div>
            <Alert>
              <TriangleAlert />
              <AlertTitle>You won’t see this key again</AlertTitle>
              <AlertDescription>SparkMan stores only the prefix. If you lose it, revoke it and create another.</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate({ name, rateLimitRpm: Number(limit) }, { onSuccess: (r) => setSecret(r.secret) })
            }}
          >
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>One key per agent or tool makes usage and revocation easy.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-code-laptop" autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-limit">Rate limit</Label>
              <Select value={limit} onValueChange={setLimit}>
                <SelectTrigger id="key-limit" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMITS.map((l) => (
                    <SelectItem key={l} value={String(l)}>
                      {l} requests / minute
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
