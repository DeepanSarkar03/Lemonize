'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { SignedIn, SignedOut, useAuth } from '@clerk/nextjs';
import { CheckCircle, Flag } from '@phosphor-icons/react';
import { registryRequest } from '@/lib/registry-browser';

export function ReportPackage({ name, versions }: { name: string; versions: string[] }) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('security');
  const [version, setVersion] = useState('');
  const [detail, setDetail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('sending');
    setMessage('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign in again before sending this report.');
      await registryRequest<{ id: string; status: string }>('/v1/reports', {
        method: 'POST',
        token,
        body: {
          packageName: name,
          reason,
          detail,
          ...(version ? { version } : {}),
        },
      });
      setState('sent');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The report could not be sent.');
      setState('error');
    }
  };

  if (state === 'sent') {
    return (
      <div className="rounded-xl bg-pastel-greenBg p-4 text-sm text-pastel-greenText">
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle size={16} weight="bold" /> Report received
        </p>
        <p className="mt-1 text-xs leading-5 opacity-80">The registry operator can now review it.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <button
        className="flex w-full items-center justify-between gap-3 text-left text-xs font-medium text-ink-600 transition-colors hover:text-ink-900"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex items-center gap-1.5"><Flag size={13} weight="bold" /> Report a concern</span>
        <span aria-hidden>{open ? '−' : '+'}</span>
      </button>

      {open ? (
        <div className="mt-4 border-t border-line pt-4">
          <SignedOut>
            <p className="text-xs leading-5 text-ink-600">
              <Link className="font-medium text-ink-900 underline underline-offset-4" href="/login">
                Sign in
              </Link>{' '}
              to report malware, impersonation, or another policy concern.
            </p>
          </SignedOut>
          <SignedIn>
            <form className="space-y-3" onSubmit={submit}>
              <div>
                <label className="label" htmlFor="report-reason">Reason</label>
                <select
                  id="report-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                >
                  <option value="security">Security vulnerability</option>
                  <option value="malware">Malware</option>
                  <option value="impersonation">Impersonation</option>
                  <option value="spam">Spam</option>
                  <option value="copyright">Copyright</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="report-version">Version (optional)</label>
                <select
                  id="report-version"
                  className="input"
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                >
                  <option value="">Entire package</option>
                  {versions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="report-detail">What did you find?</label>
                <textarea
                  id="report-detail"
                  className="input min-h-28 resize-y"
                  value={detail}
                  minLength={10}
                  maxLength={2000}
                  onChange={(event) => setDetail(event.target.value)}
                  required
                />
              </div>
              {state === 'error' ? (
                <p className="text-xs leading-5 text-pastel-redText">{message}</p>
              ) : null}
              <button className="btn w-full justify-center" type="submit" disabled={state === 'sending'}>
                {state === 'sending' ? 'Sending…' : 'Send report'}
              </button>
            </form>
          </SignedIn>
        </div>
      ) : null}
    </div>
  );
}
