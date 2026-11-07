import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

export function CopyButton({ value, label = 'Copy', toastText = 'Copied to clipboard' }: { value: string; label?: string; toastText?: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      toast.success(toastText)
      setTimeout(() => setDone(false), 1500)
    } catch {
      toast.error('Clipboard unavailable in this browser')
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()}>
      {done ? <Check /> : <Copy />}
      {label}
    </Button>
  )
}
