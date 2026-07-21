'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SignIn, SignedIn, SignedOut, useAuth } from '@clerk/nextjs';

type ApprovalState = 'idle' | 'approving' | 'approved' | 'error';
const DEVICE_CODE = /^LEMN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function ApprovalForm() {
  const { getToken } = useAuth();
  const [code, setCode] = useState('');
  const [state, setState] = useState<ApprovalState>('idle');
  const [message, setMessage] = useState('');

  const approve = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!DEVICE_CODE.test(normalized)) {
      setState('error');
      setMessage('Enter the complete code shown by the CLI, including both hyphens.');
      return;
    }
    setState('approving');
    setMessage('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Your Clerk session is unavailable. Please sign in again.');
      const registry = process.env.NEXT_PUBLIC_REGISTRY_URL;
      if (!registry) throw new Error('The registry endpoint is not configured.');
      const response = await fetch(`${registry.replace(/\/+$/, '')}/v1/auth/device/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userCode: normalized }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        throw new Error(body?.error?.message || 'The device could not be approved.');
      }
      setState('approved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The device could not be approved.');
      setState('error');
    }
  };

  if (state === 'approved') {
    return (
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-8"
        role="status"
        aria-live="polite"
      >
        <p className="tag mb-4 w-fit">Device approved</p>
        <h2 className="display-title text-2xl">Return to your terminal</h2>
        <p className="mt-3 leading-relaxed text-ink-600">
          The CLI received a 30-day token for package access and credential management. You can
          revoke it from the dashboard at any time.
        </p>
        <Link href="/dashboard" className="btn-primary mt-6 inline-flex">
          Open dashboard
        </Link>
      </div>
    );
  }

  return (
    <form
      className="w-full max-w-md rounded-2xl border border-line bg-surface p-8"
      onSubmit={approve}
      aria-busy={state === 'approving'}
    >
      <p className="tag mb-4 w-fit">CLI authorization</p>
      <h2 className="display-title text-2xl">Confirm the terminal code</h2>
      <p className="mt-3 leading-relaxed text-ink-600">
        Enter the code displayed by <code>lem login</code>. Approve only a code you started on your
        own device.
      </p>
      <p id="device-code-help" className="mt-3 text-sm leading-relaxed text-ink-600">
        Approval grants the CLI a 30-day token. Publishers can read, publish, maintain their
        packages, and create, list, or revoke their account tokens. Consumers receive read and
        token-management access.
      </p>
      <label className="mt-6 block text-sm font-medium text-ink-900" htmlFor="device-code">
        Device code
      </label>
      <input
        id="device-code"
        className="input mt-2 font-mono uppercase tracking-wider"
        value={code}
        onChange={(event) => {
          setCode(event.target.value);
          if (state === 'error') {
            setState('idle');
            setMessage('');
          }
        }}
        placeholder="LEMN-8F3K-M9QW"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={14}
        aria-invalid={state === 'error'}
        aria-describedby={
          state === 'error' ? 'device-code-help device-code-error' : 'device-code-help'
        }
        required
      />
      {state === 'error' ? (
        <p id="device-code-error" className="mt-3 text-sm text-pastel-redText" role="alert">
          {message}
        </p>
      ) : null}
      <button className="btn-primary mt-6" type="submit" disabled={state === 'approving'}>
        {state === 'approving' ? 'Approving…' : 'Approve this device'}
      </button>
    </form>
  );
}

export function DeviceApproval() {
  return (
    <>
      <SignedOut>
        <SignIn path="/login" routing="path" forceRedirectUrl="/login" />
      </SignedOut>
      <SignedIn>
        <ApprovalForm />
      </SignedIn>
    </>
  );
}
