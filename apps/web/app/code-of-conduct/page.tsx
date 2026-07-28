import type { Metadata } from 'next';
import { LegalDocument, type LegalSection } from '@/components/LegalDocument';

export const metadata: Metadata = {
  title: 'Code of Conduct',
  description: 'The standards for participating in the Lemonize community.',
};

const linkClass = 'font-medium text-ink-900 underline decoration-line underline-offset-4';

const sections: LegalSection[] = [
  {
    title: 'Our pledge',
    paragraphs: [
      'We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone, regardless of age, body size, visible or invisible disability, ethnicity, sex characteristics, gender identity and expression, level of experience, education, socio-economic status, nationality, personal appearance, race, caste, color, religion, or sexual identity and orientation.',
      'We pledge to act and interact in ways that contribute to an open, welcoming, diverse, inclusive, and healthy community.',
    ],
  },
  {
    title: 'Our standards',
    paragraphs: [
      'Examples of behavior that contributes to a positive environment for our community include:',
    ],
    items: [
      'Demonstrating empathy and kindness toward other people.',
      'Being respectful of differing opinions, viewpoints, and experiences.',
      'Giving and gracefully accepting constructive feedback.',
      'Accepting responsibility and apologizing to those affected by our mistakes, and learning from the experience.',
      'Focusing on what is best not just for us as individuals, but for the overall community.',
    ],
  },
  {
    title: 'Unacceptable behavior',
    paragraphs: ['Examples of unacceptable behavior include:'],
    items: [
      'The use of sexualized language or imagery, and sexual attention or advances of any kind.',
      'Trolling, insulting or derogatory comments, and personal or political attacks.',
      'Public or private harassment.',
      "Publishing others' private information, such as a physical or email address, without their explicit permission.",
      'Other conduct which could reasonably be considered inappropriate in a professional setting.',
    ],
  },
  {
    title: 'Enforcement responsibilities',
    paragraphs: [
      'Community leaders are responsible for clarifying and enforcing our standards of acceptable behavior and will take appropriate and fair corrective action in response to any behavior that they deem inappropriate, threatening, offensive, or harmful.',
      'Community leaders have the right and responsibility to remove, edit, or reject comments, commits, code, wiki edits, issues, and other contributions that are not aligned to this Code of Conduct, and will communicate reasons for moderation decisions when appropriate.',
    ],
  },
  {
    title: 'Scope',
    paragraphs: [
      'This Code of Conduct applies within all community spaces, and also applies when an individual is officially representing the community in public spaces. Examples of representing our community include using an official email address, posting via an official social media account, or acting as an appointed representative at an online or offline event.',
    ],
  },
  {
    title: 'Enforcement',
    paragraphs: [
      <>
        Instances of abusive, harassing, or otherwise unacceptable behavior may be reported to the
        community leaders responsible for enforcement at{' '}
        <a className={linkClass} href="mailto:abuse@lemonize.cyou">
          abuse@lemonize.cyou
        </a>
        . All complaints will be reviewed and investigated promptly and fairly.
      </>,
      'All community leaders are obligated to respect the privacy and security of the reporter of any incident.',
    ],
  },
  {
    title: 'Enforcement guidelines',
    paragraphs: [
      'Community leaders will follow these Community Impact Guidelines in determining the consequences for any action they deem in violation of this Code of Conduct:',
    ],
    orderedItems: [
      <>
        <strong className="text-ink-900">Correction.</strong>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Community impact:</strong> Use of
          inappropriate language or other behavior deemed unprofessional or unwelcome in the
          community.
        </span>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Consequence:</strong> A private, written
          warning from community leaders, providing clarity around the nature of the violation and
          an explanation of why the behavior was inappropriate. A public apology may be requested.
        </span>
      </>,
      <>
        <strong className="text-ink-900">Warning.</strong>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Community impact:</strong> A violation
          through a single incident or series of actions.
        </span>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Consequence:</strong> A warning with
          consequences for continued behavior. No interaction with the people involved, including
          unsolicited interaction with those enforcing the Code of Conduct, for a specified period
          of time. This includes avoiding interactions in community spaces as well as external
          channels like social media. Violating these terms may lead to a temporary or permanent
          ban.
        </span>
      </>,
      <>
        <strong className="text-ink-900">Temporary ban.</strong>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Community impact:</strong> A serious
          violation of community standards, including sustained inappropriate behavior.
        </span>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Consequence:</strong> A temporary ban from
          any sort of interaction or public communication with the community for a specified period
          of time. No public or private interaction with the people involved, including unsolicited
          interaction with those enforcing the Code of Conduct, is allowed during this period.
          Violating these terms may lead to a permanent ban.
        </span>
      </>,
      <>
        <strong className="text-ink-900">Permanent ban.</strong>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Community impact:</strong> Demonstrating a
          pattern of violation of community standards, including sustained inappropriate behavior,
          harassment of an individual, or aggression toward or disparagement of classes of
          individuals.
        </span>
        <span className="mt-1 block">
          <strong className="font-medium text-ink-900">Consequence:</strong> A permanent ban from
          any sort of public interaction within the community.
        </span>
      </>,
    ],
  },
  {
    title: 'Attribution',
    paragraphs: [
      <>
        This Code of Conduct is adapted from the{' '}
        <a className={linkClass} href="https://www.contributor-covenant.org">
          Contributor Covenant
        </a>
        ,{' '}
        <a
          className={linkClass}
          href="https://www.contributor-covenant.org/version/2/1/code_of_conduct.html"
        >
          version 2.1
        </a>
        . The Community Impact Guidelines were inspired by{' '}
        <a className={linkClass} href="https://github.com/mozilla/diversity">
          Mozilla&apos;s code of conduct enforcement ladder
        </a>
        .
      </>,
      <>
        Answers to common questions are available in the{' '}
        <a className={linkClass} href="https://www.contributor-covenant.org/faq">
          Contributor Covenant FAQ
        </a>
        , along with community-maintained{' '}
        <a className={linkClass} href="https://www.contributor-covenant.org/translations">
          translations
        </a>
        .
      </>,
    ],
  },
];

export default function CodeOfConductPage() {
  return (
    <LegalDocument
      title="Code of Conduct"
      description="The shared standards for participating in Lemonize community spaces."
      effectiveDate="28 July 2026"
      sections={sections}
      eyebrow="Community / Lemonize"
    />
  );
}
