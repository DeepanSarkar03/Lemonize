'use client';
import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/tailgrids/core/button';

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        setStatus('idle');
        resetTimer.current = null;
      }, 1500);
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <code className="tnum min-w-0 overflow-x-auto whitespace-nowrap font-mono text-xs text-ink-900 sm:text-sm">
        {label ?? text}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="hit-slop !min-h-8 shrink-0 gap-1.5 px-2 py-1 text-xs"
        onClick={() => void copy()}
        aria-label={status === 'copied' ? 'Copied to clipboard' : 'Copy to clipboard'}
      >
        {status === 'copied' ? <Check size={13} weight="bold" /> : <Copy size={13} weight="bold" />}
        {status === 'copied' ? 'copied' : status === 'error' ? 'retry' : 'copy'}
      </Button>
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
