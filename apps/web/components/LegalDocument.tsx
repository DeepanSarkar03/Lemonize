import type { ReactNode } from 'react';

export interface LegalSection {
  title: string;
  paragraphs?: ReactNode[];
  items?: ReactNode[];
}

interface LegalDocumentProps {
  title: string;
  description: string;
  effectiveDate: string;
  sections: LegalSection[];
}

export function LegalDocument({ title, description, effectiveDate, sections }: LegalDocumentProps) {
  return (
    <article className="mx-auto max-w-3xl">
      <header className="space-y-4 border-b border-line pb-10">
        <h1 className="font-serif text-4xl font-medium tracking-tight text-ink-900">{title}</h1>
        <p className="max-w-2xl text-lg leading-relaxed text-ink-600">{description}</p>
        <p className="font-mono text-xs text-ink-600">Effective {effectiveDate}</p>
      </header>

      <div className="space-y-10 pt-10">
        {sections.map((section) => (
          <section key={section.title} className="space-y-4">
            <h2 className="text-xl font-semibold tracking-tight text-ink-900">{section.title}</h2>
            {section.paragraphs?.map((paragraph, index) => (
              <p key={index} className="max-w-[70ch] text-[15px] leading-7 text-ink-600">
                {paragraph}
              </p>
            ))}
            {section.items ? (
              <ul className="max-w-[70ch] list-disc space-y-2 pl-5 text-[15px] leading-7 text-ink-600 marker:text-lemon-text">
                {section.items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </article>
  );
}
