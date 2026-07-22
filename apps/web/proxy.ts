import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)']);

function contentSecurityPolicy(nonce: string): string {
  const developmentScriptSource = process.env.NODE_ENV === 'production' ? '' : "'unsafe-eval'";
  const developmentConnectSources =
    process.env.NODE_ENV === 'production'
      ? ''
      : 'http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*';

  return `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://clerk.lemonize.cyou https://*.clerk.accounts.dev https://challenges.cloudflare.com ${developmentScriptSource};
    style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com;
    font-src 'self' data:;
    connect-src 'self' https://registry.lemonize.cyou https://registry-staging.lemonize.cyou https://npm.lemonize.cyou https://clerk.lemonize.cyou https://*.clerk.accounts.dev https://*.clerk.com wss://*.clerk.accounts.dev ${developmentConnectSources};
    frame-src 'self' https://clerk.lemonize.cyou https://*.clerk.accounts.dev https://challenges.cloudflare.com;
    worker-src 'self' blob:;
    manifest-src 'self';
    media-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self' https://clerk.lemonize.cyou https://*.clerk.accounts.dev;
    frame-ancestors 'none';
    ${process.env.NODE_ENV === 'production' ? 'upgrade-insecure-requests;' : ''}
  `
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export default clerkMiddleware(async (auth, request) => {
  const nextRequest = request as NextRequest;
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce);

  if (isProtectedRoute(nextRequest)) {
    await auth.protect({
      unauthenticatedUrl: new URL('/login', nextRequest.url).toString(),
    });
  }

  const requestHeaders = new Headers(nextRequest.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', policy);
  return response;
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
