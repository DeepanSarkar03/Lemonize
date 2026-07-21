import type { Metadata } from 'next';
import { LegalDocument, type LegalSection } from '@/components/LegalDocument';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'Terms governing access to and use of Lemonize.',
};

const sections: LegalSection[] = [
  {
    title: 'Using Lemonize',
    paragraphs: [
      'These terms govern your access to the Lemonize website, registry, command-line tools, and related services. By using Lemonize, you agree to these terms.',
      'Lemonize is an independent package distribution service. Features may change, pause, or be removed as the service develops.',
    ],
  },
  {
    title: 'Accounts and access',
    paragraphs: [
      'You must provide accurate account information and keep your sign-in methods secure. You are responsible for activity performed through your account or access tokens.',
      'Publishing requires a GitHub account linked through the configured sign-in provider. Your allocated package namespace is permanent and may not be transferred or shared.',
    ],
  },
  {
    title: 'Acceptable use',
    paragraphs: [
      'You may use Lemonize only for lawful software development and package distribution.',
    ],
    items: [
      "Do not publish malware, credential stealers, destructive code, or content that violates another person's rights.",
      'Do not probe, bypass, or interfere with authentication, rate limits, access controls, or service availability.',
      'Do not use the service to distribute secrets, personal data, or material you are not authorized to share.',
      'Do not misrepresent package ownership, provenance, or affiliation.',
    ],
  },
  {
    title: 'Packages and licenses',
    paragraphs: [
      'You retain ownership of packages you publish. You grant Lemonize the limited rights needed to store, copy, cache, scan, and deliver those packages as part of the service.',
      'You are responsible for your package licenses, dependencies, notices, and compliance obligations. Lemonize does not endorse or guarantee packages published through the registry.',
    ],
  },
  {
    title: 'Availability and warranties',
    paragraphs: [
      'The service is provided on an as-available basis without warranties of uninterrupted operation, fitness for a particular purpose, or freedom from errors. Keep independent backups and do not rely on Lemonize as the sole copy of important software.',
    ],
  },
  {
    title: 'Suspension and termination',
    paragraphs: [
      'Access may be suspended or terminated to protect the service, comply with law, investigate abuse, or enforce these terms. You may stop using Lemonize at any time.',
    ],
  },
  {
    title: 'Changes and contact',
    paragraphs: [
      'These terms may be updated as Lemonize changes. Material updates will be identified by a new effective date. Questions can be sent to the service operator through the channel where you received access.',
    ],
  },
];

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Use"
      description="The rules for accessing the Lemonize website, registry, and command-line tools."
      effectiveDate="17 July 2026"
      sections={sections}
    />
  );
}
