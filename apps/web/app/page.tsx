import Link from 'next/link';
import { CopyBlock } from '@/components/CopyBlock';
import { TerminalWindow } from '@/components/TerminalWindow';
import { ArrowUpRight, Package, ShieldCheck, Prohibit } from '@phosphor-icons/react/dist/ssr';

const features = [
  {
    icon: Package,
    title: 'Immutable artifacts',
    body: 'Every published version is content-addressed and stored in R2. Objects are never overwritten — a version you install today resolves to the exact same bytes a year from now.',
    accent: 'lemon',
    wide: true,
  },
  {
    icon: ShieldCheck,
    title: 'Integrity-first',
    body: 'SHA-512 SRI is verified before any tarball is extracted on your machine.',
    accent: 'blue',
  },
  {
    icon: Prohibit,
    title: 'No lifecycle scripts',
    body: 'install / postinstall scripts are disabled by design.',
    accent: 'green',
  },
];

const accentClasses: Record<string, string> = {
  lemon: 'bg-lemon-bg text-lemon-text',
  blue: 'bg-pastel-blueBg text-pastel-blueText',
  green: 'bg-pastel-greenBg text-pastel-greenText',
};

export default function Landing() {
  return (
    <div className="space-y-28">
      <section className="grid items-center gap-16 pb-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="stagger space-y-7">
          <p className="eyebrow">Global CDN · Cloudflare-powered</p>
          <h1 className="font-serif text-[clamp(2.75rem,5.5vw,4.25rem)] font-medium leading-[1.05] tracking-tight text-ink-900 [text-wrap:balance]">
            Ship packages at the edge with <span className="italic text-lemon-text">Lemonize</span>.
          </h1>
          <p className="max-w-md text-lg leading-relaxed text-ink-600">
            A developer-first package registry with immutable, content-addressed artifacts,
            integrity-verified installs and a fast global download gateway.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link href="/explore" className="btn group">
              Explore packages
              <span className="btn-icon">
                <ArrowUpRight size={13} weight="bold" />
              </span>
            </Link>
            <Link href="/docs" className="btn-ghost">Read the docs</Link>
          </div>
          <div className="max-w-md space-y-2 pt-4">
            <CopyBlock text="npm install -g @lemonize/cli" />
          </div>
        </div>

        <div className="animate-fade-up [animation-delay:120ms]">
          <TerminalWindow />
        </div>
      </section>

      <section className="stagger grid gap-4 md:grid-cols-3 md:grid-rows-2">
        {features.map(({ icon: Icon, title, body, wide, accent }) => (
          <div
            key={title}
            className={`card card-hover flex flex-col justify-between gap-4 p-8 ${
              wide ? 'md:col-span-2 md:row-span-2' : ''
            }`}
          >
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${accentClasses[accent]}`}>
              <Icon size={19} weight="bold" />
            </div>
            <div className="space-y-2">
              <h3 className={`font-medium text-ink-900 ${wide ? 'text-xl tracking-tight' : 'text-base'}`}>
                {title}
              </h3>
              <p className={`text-ink-600 ${wide ? 'max-w-md text-[15px] leading-relaxed' : 'text-sm leading-relaxed'}`}>
                {body}
              </p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
