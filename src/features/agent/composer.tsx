import { CornerDownRight, Paperclip, SendHorizontal, Square, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ImageAttachment, SlashCommandInfo } from '@/agent/protocol'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useProvider } from './providers'

const MAX_IMAGES = 4
// the API caps each image at 5 MB of base64 (≈ 3.75 MB of file)
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4)
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface MenuCommand extends SlashCommandInfo {
  skill: boolean
}

interface Attached extends ImageAttachment {
  id: string
  url: string
}

function readImage(file: File): Promise<Attached> {
  return new Promise((resolve, reject) => {
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return reject(new Error(`${file.name || 'That file'} isn’t a PNG, JPEG, GIF or WebP image`))
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error(`${file.name || 'That image'} is too large (3.7 MB max)`))
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ id: crypto.randomUUID(), url, mediaType: file.type as Attached['mediaType'], data: url.slice(url.indexOf(',') + 1) })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(file)
  })
}

/** Filter commands for the text typed after "/" (prefix matches first). */
export function matchCommands(commands: MenuCommand[], query: string): MenuCommand[] {
  const q = query.toLowerCase()
  const names = (c: MenuCommand) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
  const prefix = commands.filter((c) => names(c).some((n) => n.startsWith(q)))
  const rest = commands.filter((c) => !prefix.includes(c) && (names(c).some((n) => n.includes(q)) || c.description.toLowerCase().includes(q)))
  return [...prefix, ...rest].slice(0, 8)
}

export function Composer({
  running, sending, commands, suggestion, onSend, onStop,
}: {
  running: boolean
  sending: boolean
  commands: MenuCommand[]
  suggestion: string | null
  onSend: (text: string, images: ImageAttachment[]) => void
  onStop: () => void
}) {
  const { name } = useProvider()
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attached[]>([])
  const [active, setActive] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const slash = /^\/(\S*)$/.exec(text)
  const matches = slash ? matchCommands(commands, slash[1]) : []
  const menuOpen = !!slash && !menuDismissed && matches.length > 0
  const activeIdx = Math.min(active, Math.max(0, matches.length - 1))

  const addFiles = async (files: Iterable<File>) => {
    for (const f of files) {
      try {
        const img = await readImage(f)
        setImages((cur) => {
          if (cur.length >= MAX_IMAGES) {
            toast.error(`Attach at most ${MAX_IMAGES} images`)
            return cur
          }
          return [...cur, img]
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const submit = () => {
    const t = text.trim()
    if ((!t && images.length === 0) || sending) return
    onSend(t, images.map(({ mediaType, data }) => ({ mediaType, data })))
    setText('')
    setImages([])
  }

  const pick = (c: MenuCommand) => {
    setText(`/${c.name} `)
    setMenuDismissed(true)
    box.current?.focus()
  }

  return (
    <div className="relative border-t">
      {menuOpen && (
        <ul
          role="listbox"
          id="slash-menu"
          aria-label="Commands"
          className="absolute inset-x-3 bottom-full mb-1 max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          data-testid="slash-menu"
        >
          {matches.map((c, i) => (
            <li
              key={c.name}
              id={`slash-${c.name}`}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm', i === activeIdx && 'bg-accent text-accent-foreground')}
            >
              <span className="font-mono">/{c.name}</span>
              {c.argumentHint && <span className="font-mono text-xs text-muted-foreground">{c.argumentHint}</span>}
              {c.skill && <span className="rounded bg-claude/15 px-1 text-[10px] uppercase tracking-wide text-claude">skill</span>}
              <span className="ml-auto truncate pl-4 text-xs text-muted-foreground">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      {suggestion && !text && !running && (
        <div className="px-3 pt-2">
          <button
            type="button"
            onClick={() => {
              setText(suggestion)
              box.current?.focus()
            }}
            className="enter-fade inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:border-claude/50 hover:text-foreground"
            data-testid="suggestion"
          >
            <CornerDownRight className="size-3 shrink-0" />
            <span className="truncate">{suggestion}</span>
            <kbd className="ml-1 rounded border px-1 font-mono text-[10px]">Tab</kbd>
          </button>
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-2" data-testid="attachments">
          {images.map((img) => (
            <div key={img.id} className="enter-pop group relative size-14 overflow-hidden rounded-md border">
              <img src={img.url} alt="Attached image" className="size-full object-cover" />
              <button
                type="button"
                onClick={() => setImages((cur) => cur.filter((i) => i.id !== img.id))}
                className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-background/90 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                aria-label="Remove image"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="flex items-end gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          multiple
          hidden
          onChange={(e) => {
            void addFiles(e.target.files ?? [])
            e.target.value = ''
          }}
        />
        <Button type="button" variant="ghost" size="icon" onClick={() => fileInput.current?.click()} aria-label="Attach images">
          <Paperclip />
        </Button>
        <Textarea
          ref={box}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setMenuDismissed(false)
            setActive(0)
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
            if (files.length) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const d = e.key === 'ArrowDown' ? 1 : -1
                setActive((activeIdx + d + matches.length) % matches.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault()
                pick(matches[activeIdx])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMenuDismissed(true)
                return
              }
            }
            if (e.key === 'Tab' && !text && suggestion && !running) {
              e.preventDefault()
              setText(suggestion)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={running ? `${name} is working — messages you send now are queued` : commands.length ? `Message ${name} on this host — / for commands, paste images` : `Message ${name} on this host — paste images to attach them`}
          aria-label={`Message ${name}`}
          aria-controls={menuOpen ? 'slash-menu' : undefined}
          aria-activedescendant={menuOpen ? `slash-${matches[activeIdx].name}` : undefined}
          aria-autocomplete="list"
          autoFocus
          rows={2}
          className="max-h-48 min-h-11 resize-none"
        />
        {running && (
          <Button type="button" variant="outline" size="icon" onClick={onStop} aria-label="Stop">
            <Square />
          </Button>
        )}
        <Button type="submit" size="icon" disabled={(!text.trim() && images.length === 0) || sending} aria-label="Send">
          <SendHorizontal />
        </Button>
      </form>
    </div>
  )
}
