import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Sanitised markdown (text panels). Links open in a new tab. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source ?? '', { async: false, gfm: true, breaks: true }) as string;
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }, [source]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
