import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useProvider } from './providers'

/** Preview (dry run) and confirm rewinding the files Claude changed after a user message. */
export function RewindDialog({ sessionId, userUuid, onClose }: { sessionId: string; userUuid: string | null; onClose: () => void }) {
  const { api } = useProvider()
  const preview = useQuery({
    queryKey: ['agent', sessionId, 'rewind-preview', userUuid],
    queryFn: () => api.rewind(sessionId, userUuid!, true),
    enabled: userUuid !== null,
    retry: false,
    gcTime: 0,
  })
  const rewind = useMutation({
    mutationFn: () => api.rewind(sessionId, userUuid!, false),
    onSuccess: (r) => {
      if (r.error || !r.canRewind) toast.error(r.error ?? 'Nothing to rewind')
      else toast.success(`Rewound ${r.filesChanged.length} file${r.filesChanged.length === 1 ? '' : 's'}`)
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const p = preview.data
  return (
    <Dialog open={userUuid !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rewind files to before this message?</DialogTitle>
          <DialogDescription>Restores the files Claude changed from this point on. The conversation stays as it is; commands Claude ran aren’t undone.</DialogDescription>
        </DialogHeader>
        <div data-testid="rewind-preview">
          {preview.isPending && <Skeleton className="h-20" />}
          {preview.isError && <p className="text-sm text-level-error">{preview.error.message}</p>}
          {p && (p.error || !p.canRewind) && <p className="text-sm text-muted-foreground">{p.error ?? 'No file checkpoints for this message.'}</p>}
          {p && p.canRewind && !p.error && (
            <div className="space-y-2">
              <div className="text-sm">
                {p.filesChanged.length} file{p.filesChanged.length === 1 ? '' : 's'} · <span className="text-brand">+{p.insertions}</span> <span className="text-level-error">−{p.deletions}</span>
              </div>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border bg-surface-2 p-2 font-mono text-xs">
                {p.filesChanged.map((f) => (
                  <li key={f} className="truncate">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!p?.canRewind || !!p.error || p.filesChanged.length === 0 || rewind.isPending} onClick={() => rewind.mutate()}>
            Rewind files
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
