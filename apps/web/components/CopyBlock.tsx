'use client';
import { useState } from 'react';
import { Copy, Check } from '@phosphor-icons/react/dist/ssr';

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3">
      <code className="tnum font-mono text-sm text-ink-900">{label ?? text}</code>
      <button
        className="hit-slop group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-600 transition-colors duration-150 ease-out hover:text-ink-900 active:scale-95"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label="Copy to clipboard"
      >
        {copied ? <Check size={13} weight="bold" /> : <Copy size={13} weight="bold" />}
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
