import type { Metadata } from 'next';
import { LegalDocument, type LegalSection } from '@/components/LegalDocument';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'How Lemonize handles account and service data.',
};

const sections: LegalSection[] = [
  {
    title: 'Information we collect',
    paragraphs: [
      'Lemonize collects the information needed to authenticate users, operate the registry, and keep the service secure.',
    ],
    items: [
      'Account details supplied through Clerk, such as your name, email address, profile image, and linked GitHub account details when you choose GitHub sign-in.',
      'Registry activity, including packages, versions, ownership, access tokens, publication events, and audit records.',
      'Technical information such as IP address, browser details, request identifiers, timestamps, and security or rate-limit events.',
      'Essential cookies and similar browser storage used to maintain your authenticated session and protect account access.',
    ],
  },
  {
    title: 'How we use information',
    items: [
      'Authenticate your account, verify a linked GitHub identity, and allocate your publisher namespace.',
      'Provide package publishing, metadata, downloads, and account features.',
      'Detect abuse, investigate incidents, enforce limits, and improve reliability.',
      'Comply with legal obligations and protect users, Lemonize, and third parties.',
    ],
  },
  {
    title: 'Service providers',
    paragraphs: [
      'Lemonize uses service providers to run the product. Clerk processes identity and session data. Cloudflare provides registry compute, storage, caching, and network delivery. Hosting and deployment providers may process website requests and operational logs.',
      'These providers process information under their own terms and privacy notices. Lemonize does not sell personal information or use it for third-party advertising.',
    ],
  },
  {
    title: 'Retention and security',
    paragraphs: [
      'Information is retained for as long as needed to operate the service, maintain package integrity and audit history, resolve disputes, and meet legal obligations. Retention periods vary by data type and backup lifecycle.',
      'Lemonize uses access controls, signed sessions, transport encryption, and operational monitoring. No internet service can guarantee absolute security, so avoid publishing secrets or sensitive personal information in packages.',
    ],
  },
  {
    title: 'Your choices',
    paragraphs: [
      'You may request access to, correction of, or deletion of account information, subject to package integrity, security, and legal retention requirements. You can also sign out to clear the active browser session.',
      'Send privacy questions or requests to the service operator through the channel where you received access. Verification may be required before an account request is completed.',
    ],
  },
  {
    title: 'Changes',
    paragraphs: [
      'This policy may be updated as the service and its providers change. Material updates will be identified by a new effective date.',
    ],
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      description="What Lemonize collects, why it is used, and the choices available to you."
      effectiveDate="17 July 2026"
      sections={sections}
    />
  );
}
