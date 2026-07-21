import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr';
import { CopyBlock } from '@/components/CopyBlock';

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'Use the Lemonize npm edge gateway and native package registry.',
};

const publishSteps = [
  {
    title: 'Install the CLI',
    commands: ['npm install -g @lemonize/cli'],
  },
  {
    title: 'Authenticate',
    commands: ['lem login', 'lem config set registry https://registry.lemonize.cyou'],
  },
  {
    title: 'Publish',
    commands: ['lem init && lem publish'],
  },
  {
    title: 'Install and run',
    commands: [
      'lem add @demo/utils --source lemonize',
      'lemx create-lemon-app -- --template minimal',
    ],
  },
];

export default function Docs() {
  return (
    <div className="grid gap-12 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16">
      <aside className="hidden lg:block">
        <nav className="sticky top-28 space-y-1 text-sm" aria-label="Documentation sections">
          <p className="technical-label mb-4 text-ink-600">On this page</p>
          <a
            className="block border-l-2 border-citron py-2 pl-4 font-medium text-ink-900"
            href="#npm-cdn"
          >
            npm CDN
          </a>
          <a
            className="block border-l-2 border-line py-2 pl-4 text-ink-600 hover:text-ink-900"
            href="#native-registry"
          >
            Native registry
          </a>
          <a
            className="block border-l-2 border-line py-2 pl-4 text-ink-600 hover:text-ink-900"
            href="#delivery-model"
          >
            Delivery model
          </a>
        </nav>
      </aside>

      <article className="min-w-0 max-w-3xl">
        <header className="border-b border-ink-900/15 pb-10">
          <p className="technical-label text-lemon-text">Docs / quickstart</p>
          <h1 className="display-title mt-4 text-5xl sm:text-6xl">Two ways to ship packages.</h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-ink-600">
            Use the npm-compatible gateway for public packages, or the native registry for packages
            you publish through Lemonize.
          </p>
        </header>

        <section id="npm-cdn" className="scroll-mt-28 border-b border-line py-12">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="technical-label text-lemon-text">01 / npm edge gateway</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.045em] text-ink-900">
                Install through the CDN
              </h2>
            </div>
            <a
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-900 hover:text-lemon-text"
              href="https://npm.lemonize.cyou/-/ping"
            >
              Gateway status <ArrowUpRight size={14} weight="bold" />
            </a>
          </div>
          <p className="mt-5 max-w-2xl leading-7 text-ink-600">
            Add the registry flag to one install. npm still resolves the public package; Lemonize
            provides the metadata and tarball route through Cloudflare.
          </p>
          <div className="mt-7 space-y-3">
            <CopyBlock text="npm install zod --registry=https://npm.lemonize.cyou" />
            <CopyBlock text="npm install -g @lemonize/cli --registry=https://npm.lemonize.cyou" />
          </div>

          <div className="mt-9 rounded-2xl border border-line bg-surface p-6">
            <p className="font-semibold text-ink-900">Make it the project default</p>
            <p className="mt-2 text-sm leading-6 text-ink-600">
              Save the registry in your project-level{' '}
              <code className="font-mono text-xs text-ink-900">.npmrc</code>. Commit that choice
              only if every contributor should use the gateway.
            </p>
            <div className="mt-5">
              <CopyBlock text="npm config set registry https://npm.lemonize.cyou --location=project" />
            </div>
          </div>
        </section>

        <section id="native-registry" className="scroll-mt-28 border-b border-line py-12">
          <p className="technical-label text-lemon-text">02 / native registry</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.045em] text-ink-900">
            Publish with Lemonize
          </h2>
          <p className="mt-5 max-w-2xl leading-7 text-ink-600">
            Sign in to claim your publisher namespace, authorize the CLI, then publish an immutable
            version from your project directory.
          </p>

          <ol className="mt-9 space-y-9 border-l border-line pl-6 sm:pl-8">
            {publishSteps.map((step, index) => (
              <li key={step.title} className="relative">
                <span className="absolute -left-[2.12rem] top-0 flex h-5 w-5 items-center justify-center rounded-full bg-carbon font-mono text-[9px] text-citron sm:-left-[2.62rem]">
                  {index + 1}
                </span>
                <h3 className="font-semibold text-ink-900">{step.title}</h3>
                <div className="mt-3 space-y-2">
                  {step.commands.map((command) => (
                    <CopyBlock key={command} text={command} />
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="delivery-model" className="scroll-mt-28 py-12">
          <p className="technical-label text-lemon-text">03 / delivery model</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.045em] text-ink-900">
            Know what is stored
          </h2>
          <div className="mt-7 grid gap-px overflow-hidden rounded-2xl bg-line sm:grid-cols-2">
            <div className="bg-surface p-6">
              <p className="technical-label text-ink-600">Public npm packages</p>
              <p className="mt-4 text-sm leading-6 text-ink-600">
                Requested from npm on demand and cached by Cloudflare when eligible. They are not
                archived in Lemonize&apos;s R2 bucket.
              </p>
            </div>
            <div className="bg-surface p-6">
              <p className="technical-label text-ink-600">Native Lemonize packages</p>
              <p className="mt-4 text-sm leading-6 text-ink-600">
                Stored immutably in R2 and served through the registry download gateway. The CLI
                verifies SHA-512 before extraction.
              </p>
            </div>
          </div>
          <p className="mt-6 text-sm leading-6 text-ink-600">
            Need an account?{' '}
            <Link
              className="font-medium text-ink-900 underline decoration-citron decoration-2 underline-offset-4"
              href="/login"
            >
              Sign in with GitHub
            </Link>
            .
          </p>
        </section>
      </article>
    </div>
  );
}
