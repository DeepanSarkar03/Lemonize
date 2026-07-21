import Link from 'next/link';
import {
  ArrowClockwise,
  ArrowRight,
  ArrowUpRight,
  Package,
  ShieldCheck,
} from '@phosphor-icons/react/dist/ssr';
import { BrandMark } from '@/components/BrandMark';
import { CopyBlock } from '@/components/CopyBlock';
import { TerminalWindow } from '@/components/TerminalWindow';

const route = [
  {
    number: '01',
    title: 'Request',
    body: 'Point npm at the Lemonize gateway. Package names, versions, and lockfiles keep working as expected.',
  },
  {
    number: '02',
    title: 'Resolve',
    body: 'A cache miss is resolved from the public npm registry and tarball URLs are routed back through Lemonize.',
  },
  {
    number: '03',
    title: 'Deliver',
    body: 'Eligible metadata and tarballs are cached by Cloudflare and served from the edge on later requests.',
  },
];

const capabilities = [
  {
    icon: ArrowClockwise,
    label: 'Pull-through, not a mirror',
    body: 'New packages are fetched on demand. Lemonize does not keep an R2 archive of upstream npm tarballs.',
  },
  {
    icon: ShieldCheck,
    label: 'Integrity stays intact',
    body: 'Upstream package metadata and integrity fields are preserved while download URLs are safely rewritten.',
  },
  {
    icon: Package,
    label: 'A native registry too',
    body: 'Install immutable first-party packages today. Namespace-scoped publishing remains gated until the production write cutover.',
  },
];

export default function Landing() {
  return (
    <div className="space-y-24 sm:space-y-32">
      <section className="route-grid relative isolate overflow-hidden rounded-[2rem] bg-carbon text-pulp">
        <div
          className="pointer-events-none absolute -right-24 -top-28 h-96 w-96 rounded-full border-[72px] border-citron/[0.06]"
          aria-hidden
        />
        <div className="relative grid gap-14 px-6 py-8 sm:px-10 sm:py-12 lg:grid-cols-[1.03fr_0.97fr] lg:items-center lg:px-14 lg:py-16">
          <div className="stagger max-w-xl">
            <div className="mb-9 flex items-center gap-3">
              <BrandMark className="h-10 w-10" tone="onDark" />
              <span className="technical-label text-pulp/65">
                Global package delivery / edge 01
              </span>
            </div>
            <p className="mb-5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-citron">
              <span className="h-1.5 w-1.5 rounded-full bg-citron" />
              npm-compatible edge gateway
            </p>
            <h1 className="max-w-[9ch] text-[clamp(3.4rem,7.2vw,6.75rem)] font-medium leading-[0.88] tracking-[-0.075em] text-pulp">
              From origin{' '}
              <span className="font-serif font-medium italic text-citron">to edge.</span>
            </h1>
            <p className="mt-7 max-w-lg text-base leading-7 text-pulp/62 sm:text-lg">
              One fast path for public npm packages and immutable first-party releases—resolved at
              the source, routed through Cloudflare, and delivered with integrity intact.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/docs#npm-cdn" className="btn-acid group">
                Use the npm CDN
                <ArrowRight
                  className="transition-transform group-hover:translate-x-0.5"
                  size={16}
                  weight="bold"
                />
              </Link>
              <Link
                href="/explore"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/15 px-5 py-3 text-sm text-pulp transition-colors hover:border-white/30 hover:bg-white/5"
              >
                Explore native packages
              </Link>
            </div>
          </div>

          <div className="animate-fade-up lg:pl-3 [animation-delay:120ms]">
            <TerminalWindow />
            <div className="mt-4 [&>div]:border-white/10 [&>div]:bg-white/5 [&_button]:text-pulp/55 [&_button:hover]:text-citron [&_code]:text-pulp">
              <CopyBlock
                text="npm install -g @lemonize/cli --registry=https://npm.lemonize.cyou"
                label="npm install -g @lemonize/cli"
              />
            </div>
          </div>
        </div>

        <div className="relative grid border-t border-white/10 sm:grid-cols-3">
          {[
            ['ORIGIN', 'registry.npmjs.org'],
            ['EDGE GATEWAY', 'npm.lemonize.cyou'],
            ['UPSTREAM ARCHIVE', 'None — cache only'],
          ].map(([label, value]) => (
            <div
              key={label}
              className="border-b border-white/10 px-6 py-5 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 lg:px-10"
            >
              <p className="technical-label text-pulp/60">{label}</p>
              <p className="mt-2 font-mono text-xs text-pulp/75">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="route-title">
        <div className="grid gap-8 border-b border-ink-900/15 pb-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="technical-label text-lemon-text">The delivery path</p>
            <h2 id="route-title" className="display-title mt-4 text-4xl sm:text-5xl">
              A shorter route to the package.
            </h2>
          </div>
          <p className="max-w-xl text-base leading-7 text-ink-600 lg:justify-self-end">
            Lemonize is a pull-through gateway. The first request still reaches npm; cacheable
            responses then become available from Cloudflare&apos;s network for subsequent requests.
          </p>
        </div>

        <ol className="grid gap-px overflow-hidden rounded-2xl bg-line md:grid-cols-3">
          {route.map((step) => (
            <li key={step.number} className="group relative bg-surface p-7 sm:p-8">
              <div className="mb-14 flex items-center justify-between">
                <span className="technical-label text-ink-600">{step.number} / 03</span>
                <span className="h-2.5 w-2.5 rounded-full border-2 border-ink-900/20 bg-surface transition-colors group-hover:border-citron group-hover:bg-citron" />
              </div>
              <h3 className="text-lg font-semibold tracking-[-0.025em] text-ink-900">
                {step.title}
              </h3>
              <p className="mt-3 text-sm leading-6 text-ink-600">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="grid gap-5 lg:grid-cols-[1.35fr_0.65fr]"
        aria-label="Lemonize capabilities"
      >
        <div className="rounded-[2rem] border border-ink-900/10 bg-surface p-7 sm:p-10">
          <div className="flex flex-col gap-6 border-b border-line pb-9 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="technical-label text-lemon-text">npm / pull-through CDN</p>
              <h2 className="display-title mt-4 max-w-lg text-4xl sm:text-5xl">
                Use npm. Change one URL.
              </h2>
            </div>
            <a
              href="https://npm.lemonize.cyou/-/ping"
              className="group inline-flex shrink-0 items-center gap-2 text-sm font-medium text-ink-900"
            >
              Check gateway
              <ArrowUpRight
                size={15}
                weight="bold"
                className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
              />
            </a>
          </div>
          <div className="mt-8 max-w-2xl">
            <CopyBlock text="npm install zod --registry=https://npm.lemonize.cyou" />
          </div>
          <div className="mt-9 grid gap-7 sm:grid-cols-2">
            <p className="text-sm leading-6 text-ink-600">
              Package metadata is requested from npm, rewritten so tarballs return through the same
              hostname, and streamed to the client without an upstream R2 mirror.
            </p>
            <p className="text-sm leading-6 text-ink-600">
              Cache misses depend on npm&apos;s response time. Edge hits avoid that origin round
              trip; no claim of a fixed millisecond latency is made.
            </p>
          </div>
        </div>

        <aside className="route-grid flex min-h-[28rem] flex-col justify-between overflow-hidden rounded-[2rem] bg-graphite p-7 text-pulp sm:p-9">
          <div>
            <p className="technical-label text-citron">Native registry / read-only launch</p>
            <h2 className="mt-5 text-3xl font-medium tracking-[-0.05em]">
              First-party packages. Immutable by design.
            </h2>
            <p className="mt-5 text-sm leading-6 text-pulp/55">
              Browse and install content-addressed artifacts now. Publishing with{' '}
              <code className="text-citron">lem</code> opens only after the separate production
              write gate is approved.
            </p>
          </div>
          <div>
            <div className="mb-6 flex items-center gap-3 border-b border-white/10 pb-6">
              <ShieldCheck size={22} weight="bold" className="text-citron" />
              <span className="font-mono text-xs text-pulp/70">SHA-512 verified installs</span>
            </div>
            <Link
              href="/docs"
              className="inline-flex items-center gap-2 text-sm font-medium text-citron hover:text-pulp"
            >
              Read the registry guide <ArrowRight size={15} weight="bold" />
            </Link>
          </div>
        </aside>
      </section>

      <section className="border-y border-ink-900/15 py-10 sm:py-14">
        <div className="grid gap-9 md:grid-cols-3">
          {capabilities.map(({ icon: Icon, label, body }) => (
            <div key={label}>
              <Icon size={20} weight="bold" className="text-lemon-text" />
              <h3 className="mt-6 font-semibold tracking-[-0.025em] text-ink-900">{label}</h3>
              <p className="mt-3 text-sm leading-6 text-ink-600">{body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
