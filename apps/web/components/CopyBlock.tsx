'use client';
import { useState } from 'react';
import { Copy, Check } from '@phosphor-icons/react/dist/ssr';

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 1500);
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <code className="tnum min-w-0 overflow-x-auto whitespace-nowrap font-mono text-xs text-ink-900 sm:text-sm">
        {label ?? text}
      </code>
      <button
        type="button"
        className="hit-slop group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-600 transition-colors duration-150 ease-out hover:text-ink-900 active:scale-95"
        onClick={() => void copy()}
        aria-label={status === 'copied' ? 'Copied to clipboard' : 'Copy to clipboard'}
      >
        {status === 'copied' ? <Check size={13} weight="bold" /> : <Copy size={13} weight="bold" />}
        {status === 'copied' ? 'copied' : status === 'error' ? 'retry' : 'copy'}
      </button>
      <span className="sr-only" aria-live="polite">
        {status === 'copied'
          ? 'Copied to clipboard.'
          : status === 'error'
            ? 'Clipboard access failed. Try copying the command manually.'
            : ''}
      </span>
    </div>
  );
}
