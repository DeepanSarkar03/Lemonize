import { describe, expect, it } from 'vitest';
import { loadConfig, type Env } from '../src/lib/env.js';
import { appwriteApiBaseUrl, stripTrailingSlashes } from '../src/lib/url.js';

const ADVERSARIAL_SUFFIX = '/'.repeat(250_000);

describe('URL normalization', () => {
  it('removes adversarially long trailing-slash suffixes', () => {
    expect(stripTrailingSlashes(`https://example.test/path${ADVERSARIAL_SUFFIX}`)).toBe(
      'https://example.test/path',
    );
  });

  it('normalizes every externally configured registry URL', () => {
    const config = loadConfig({
      REGISTRY_BASE_URL: `https://registry.example.test${ADVERSARIAL_SUFFIX}`,
      WEB_BASE_URL: `https://www.example.test${ADVERSARIAL_SUFFIX}`,
      CLERK_ISSUER: `https://clerk.example.test${ADVERSARIAL_SUFFIX}`,
    } as unknown as Env);

    expect(config.registryBaseUrl).toBe('https://registry.example.test');
    expect(config.webBaseUrl).toBe('https://www.example.test');
    expect(config.clerkIssuer).toBe('https://clerk.example.test');
  });

  it('normalizes an Appwrite v1 endpoint with an adversarial suffix', () => {
    expect(appwriteApiBaseUrl(`https://appwrite.example.test/v1${ADVERSARIAL_SUFFIX}`)).toBe(
      'https://appwrite.example.test/v1',
    );
  });
});
