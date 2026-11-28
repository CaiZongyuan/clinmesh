import { Button } from '@clinmesh/ui/components/button'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Content, PhrasingContent, Root } from 'mdast'
import { Fragment, useMemo, useState, type ReactNode } from 'react'

function isSafeHref(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://clinmesh.local')
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function CodeFenceBlock({
  lang,
  value,
}: {
  lang?: string | null | undefined
  value: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable.
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted/45">
      <div className="flex items-center justify-between gap-2 border-b border-border/80 bg-muted/70 px-2.5 py-1 text-[0.6875rem] text-muted-foreground">
        <span className="font-mono uppercase">{lang || 'text'}</span>
        <Button
          aria-label="复制代码块"
          className="h-5 gap-1 px-1.5 text-[0.6875rem]"
          onClick={() => void handleCopy()}
          size="xs"
          type="button"
          variant="ghost"
        >
          {copied ? (
            <>
              <CheckIcon aria-hidden="true" className="size-3 text-success" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <CopyIcon aria-hidden="true" className="size-3" />
              <span>复制</span>
            </>
          )}
        </Button>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-xs leading-relaxed">
        <code>{value}</code>
      </pre>
    </div>
  )
}

function renderInline(nodes: readonly PhrasingContent[], keyPrefix: string): ReactNode {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    switch (node.type) {
      case 'text':
        return <Fragment key={key}>{node.value}</Fragment>
      case 'strong':
        return <strong className="font-semibold text-foreground" key={key}>{renderInline(node.children, key)}</strong>
      case 'emphasis':
        return <em className="italic" key={key}>{renderInline(node.children, key)}</em>
      case 'inlineCode':
        return (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground" key={key}>
            {node.value}
          </code>
        )
      case 'break':
        return <br key={key} />
      case 'link':
        if (!isSafeHref(node.url)) {
          return <Fragment key={key}>{renderInline(node.children, key)}</Fragment>
        }
        return (
          <a
            className="text-info underline underline-offset-2 hover:opacity-80"
            href={node.url}
            key={key}
            rel="noopener noreferrer"
            target="_blank"
          >
            {renderInline(node.children, key)}
          </a>
        )
      default:
        if ('value' in node && typeof node.value === 'string') {
          return <Fragment key={key}>{node.value}</Fragment>
        }
        if ('children' in node && Array.isArray(node.children)) {
          return <Fragment key={key}>{renderInline(node.children as PhrasingContent[], key)}</Fragment>
        }
        return null
    }
  })
}

function renderBlocks(nodes: readonly Content[], keyPrefix: string): ReactNode {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    switch (node.type) {
      case 'heading': {
        const content = renderInline(node.children, key)
        if (node.depth === 1) return <h2 className="mt-3 mb-1.5 text-base font-semibold tracking-tight text-foreground" key={key}>{content}</h2>
        if (node.depth === 2) return <h3 className="mt-2.5 mb-1 text-sm font-semibold text-foreground" key={key}>{content}</h3>
        return <h4 className="mt-2 mb-0.5 text-sm font-medium text-foreground" key={key}>{content}</h4>
      }
      case 'paragraph':
        return <p className="my-1.5 leading-relaxed break-words" key={key}>{renderInline(node.children, key)}</p>
      case 'list':
        return node.ordered ? (
          <ol className="my-1.5 list-decimal space-y-1 pl-5" key={key}>
            {node.children.map((item, itemIdx) => (
              <li className="leading-relaxed" key={`${key}-li-${itemIdx}`}>
                {renderBlocks(item.children, `${key}-li-${itemIdx}`)}
              </li>
            ))}
          </ol>
        ) : (
          <ul className="my-1.5 list-disc space-y-1 pl-5" key={key}>
            {node.children.map((item, itemIdx) => (
              <li className="leading-relaxed" key={`${key}-li-${itemIdx}`}>
                {renderBlocks(item.children, `${key}-li-${itemIdx}`)}
              </li>
            ))}
          </ul>
        )
      case 'blockquote':
        return (
          <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground" key={key}>
            {renderBlocks(node.children, key)}
          </blockquote>
        )
      case 'code':
        return <CodeFenceBlock key={key} lang={node.lang} value={node.value} />
      case 'thematicBreak':
        return <hr className="my-3 border-border" key={key} />
      default:
        return null
    }
  })
}

export function MarkdownRenderer({ content }: { content: string }): React.JSX.Element {
  const tree = useMemo<Root>(() => fromMarkdown(content), [content])
  return <div className="min-w-0 text-sm">{renderBlocks(tree.children, 'md')}</div>
}
