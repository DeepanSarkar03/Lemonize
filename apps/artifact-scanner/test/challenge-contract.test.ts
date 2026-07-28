import { expect, test } from 'vitest';
import { scannerChallengeHeaders } from '../../../scripts/ops/verify-appwrite-scanner-fallback.mjs';
import { verifyRequestSignature } from '../src/signing.js';

test('the deployment fallback challenge matches the scanner verifier contract', () => {
  const secret = 'scanner-test-secret-that-is-long-enough';
  const now = new Date('2026-07-29T00:00:00.000Z');
  const url = 'https://scanner.functions.example/__lemonize_secret_challenge';
  const body = new TextEncoder().encode('{}');
  const headers = scannerChallengeHeaders(secret, now);

  expect(headers).toEqual({
    'content-type': 'application/json',
    'x-lemonize-timestamp': '1785283200',
    'x-lemonize-signature': 'v1=955f0c9ccb11fadebf8887c2c0a840efacf8885b521907b7d283ab61aaf9029c',
  });
  expect(() =>
    verifyRequestSignature({
      secret,
      method: 'POST',
      url,
      headers: new Headers(headers),
      body,
      now,
      maxClockSkewSeconds: 300,
    }),
  ).not.toThrow();
});
