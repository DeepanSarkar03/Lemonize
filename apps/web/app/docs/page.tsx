import { CopyBlock } from '@/components/CopyBlock';

const sections = [
  {
    title: 'Install the CLI',
    body: null,
    commands: ['npm install -g @lemonize/cli'],
  },
  {
    title: 'Authenticate',
    body: <>Point at a custom registry with the command below.</>,
    commands: ['lem login', 'lem config set registry https://registry.lemonize.cyou'],
  },
  {
    title: 'Publish',
    body: null,
    commands: ['lem init && lem publish'],
  },
  {
    title: 'Install & run',
    body: null,
    commands: [
      'lem add @demo/utils --source lemonize',
      'lemx create-lemon-app -- --template minimal',
    ],
  },
];

export default function Docs() {
  return (
    <article className="max-w-2xl space-y-14">
      <div className="space-y-2">
        <h1 className="font-serif text-3xl font-medium tracking-tight text-ink-900">Documentation</h1>
        <p className="text-ink-600">Get started with the Lemonize CLI in a minute.</p>
      </div>

      <div className="space-y-10 border-l border-line pl-6">
        {sections.map((s) => (
          <section key={s.title} className="space-y-3">
            <h2 className="text-lg font-semibold text-ink-900">{s.title}</h2>
            {s.body ? <p className="text-sm text-ink-600">{s.body}</p> : null}
            <div className="space-y-2">
              {s.commands.map((c) => (
                <CopyBlock key={c} text={c} />
              ))}
            </div>
          </section>
        ))}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-ink-900">How delivery works</h2>
          <p className="text-sm leading-relaxed text-ink-600">
            Tarballs are stored immutably in Cloudflare R2 and streamed through the Worker download
            gateway with a one-year immutable cache header. Metadata is cached briefly with
            stale-while-revalidate. The CLI verifies SHA-512 integrity before extraction.
          </p>
          <code className="code block break-all text-xs">
            Cache-Control: public, max-age=31536000, immutable
          </code>
        </section>
      </div>
    </article>
  );
}
