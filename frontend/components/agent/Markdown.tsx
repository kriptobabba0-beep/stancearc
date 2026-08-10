// components/agent/Markdown.tsx — a deliberately tiny markdown renderer for copilot replies.
//
// The model emits a small, predictable subset — paragraphs, **bold**, *italic*, `code`,
// and -/1. lists — so this renders exactly that and nothing more (no dependency, no HTML
// injection surface: everything is built as React elements from plain text).
import { Fragment, type ReactNode } from 'react';

/** Inline pass: **bold**, *italic*, `code`. PURE. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={key++} className="font-semibold text-ink">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key++} className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">{tok.slice(1, -1)}</code>);
    else out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.length === 0) return null;
        const isBullet = lines.every((l) => /^\s*[-•]\s+/.test(l));
        const isNumbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
        if (isBullet || isNumbered) {
          const items = lines.map((l) => l.replace(/^\s*(?:[-•]|\d+[.)])\s+/, ''));
          const List = isNumbered ? 'ol' : 'ul';
          return (
            <List key={bi} className={isNumbered ? 'my-1.5 list-decimal space-y-1 pl-5' : 'my-1.5 list-disc space-y-1 pl-5'}>
              {items.map((it, ii) => (
                <li key={ii}>{renderInline(it)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={bi} className={bi > 0 ? 'mt-2' : undefined}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
