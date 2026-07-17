const lines = [
  { prompt: true, text: 'lem publish' },
  { text: 'Packing project…' },
  { text: 'stape-cli@1.4.0  12 files, 84 KB', dim: true },
  { text: 'Requesting publish intent…' },
  { text: 'Uploading tarball…' },
  { ok: true, text: 'Published stape-cli@1.4.0 to registry.lemonize.cyou' },
  { prompt: true, text: 'lem add stape-cli' },
  { text: 'Resolved 1.4.0 · sha512-9k2f…c81a', dim: true },
  { ok: true, text: 'Installed in 0.3s' },
];

export function TerminalWindow() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line bg-paper px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="ml-2 tag">registry.lemonize.cyou</span>
      </div>
      <div className="space-y-2 p-5 font-mono text-[13px] leading-relaxed">
        {lines.map((l, i) => (
          <p key={i} className={l.dim ? 'text-ink-600' : l.ok ? 'text-pastel-greenText' : 'text-ink-900'}>
            {l.prompt ? <span className="text-lemon-text">❯ </span> : null}
            {l.ok ? '✓ ' : null}
            {l.text}
          </p>
        ))}
        <p className="text-ink-900">
          <span className="text-lemon-text">❯ </span>
          <span className="animate-pulse text-ink-600">▍</span>
        </p>
      </div>
    </div>
  );
}
