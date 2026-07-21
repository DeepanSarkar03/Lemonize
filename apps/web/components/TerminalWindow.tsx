const lines = [
  { kind: 'prompt', text: 'npm install zod --registry=https://npm.lemonize.cyou' },
  { kind: 'meta', label: 'resolve', text: 'zod@latest from npmjs.org' },
  { kind: 'meta', label: 'route', text: 'tarball through npm.lemonize.cyou' },
  { kind: 'success', label: 'edge', text: 'cache-ready · integrity preserved' },
  { kind: 'done', text: 'added 1 package in 642ms' },
] as const;

export function TerminalWindow() {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-white/10 bg-[#0B0D0A] shadow-[0_32px_80px_rgba(0,0,0,0.28)]"
      aria-label="Example npm install through the Lemonize CDN"
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2" aria-hidden>
          <span className="h-2 w-2 rounded-full bg-citron" />
          <span className="h-2 w-2 rounded-full bg-white/15" />
          <span className="h-2 w-2 rounded-full bg-white/15" />
        </div>
        <span className="technical-label text-pulp/65">npm.lemonize.cyou</span>
      </div>

      <div className="space-y-4 p-5 font-mono text-[12px] leading-relaxed sm:p-6 sm:text-[13px]">
        {lines.map((line, index) => (
          <p
            key={line.text}
            className={
              line.kind === 'success'
                ? 'text-citron'
                : line.kind === 'done'
                  ? 'text-pulp'
                  : line.kind === 'meta'
                    ? 'text-pulp/55'
                    : 'break-all text-pulp'
            }
          >
            {line.kind === 'prompt' ? <span className="mr-2 text-citron">❯</span> : null}
            {'label' in line ? (
              <span className="mr-3 inline-block w-14 text-pulp/60">{line.label}</span>
            ) : null}
            {line.kind === 'done' ? <span className="mr-2 text-citron">✓</span> : null}
            {line.text}
            {index === lines.length - 1 ? (
              <span
                className="ml-2 inline-block h-3 w-1.5 animate-pulse bg-citron align-middle"
                aria-hidden
              />
            ) : null}
          </p>
        ))}
      </div>

      <div className="grid border-t border-white/10 bg-white/[0.02] sm:grid-cols-3">
        {[
          ['UPSTREAM', 'npmjs.org'],
          ['GATEWAY', 'Cloudflare'],
          ['ARCHIVE', 'none'],
        ].map(([label, value]) => (
          <div
            key={label}
            className="border-b border-white/10 px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
          >
            <p className="technical-label text-pulp/60">{label}</p>
            <p className="mt-1 truncate font-mono text-[10px] text-pulp/65 sm:text-[11px]">
              {value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
