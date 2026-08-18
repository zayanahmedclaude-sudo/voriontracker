'use client';

import { apiFetch } from '@/lib/api-client';
import { FormEvent, Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import logo from '@/public/vorion-logo-dark.png';

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const initialEmail = useMemo(() => searchParams.get('email') || '', [searchParams]);
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const response = await apiFetch<Response>('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data?.error || 'Unable to send reset link.');
        return;
      }

      setSuccess(data?.message || 'If an account exists for this email, a password reset link has been sent.');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 20px',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
        background:
          'radial-gradient(circle at top left, rgba(0,80,176,.14), transparent 32%), linear-gradient(180deg, #F4F7FB 0%, #EEF2F8 100%)',
        color: '#0A0A0A',
      }}
    >
      <style>{`
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus {
          -webkit-text-fill-color: #0A0A0A !important;
          -webkit-box-shadow: 0 0 0px 1000px #FFFFFF inset !important;
          box-shadow: 0 0 0px 1000px #FFFFFF inset !important;
          caret-color: #0A0A0A !important;
        }
      `}</style>

      <div
        style={{
          width: '100%',
          maxWidth: 520,
          background: '#FFFFFF',
          border: '1px solid rgba(10,10,10,.10)',
          borderRadius: 24,
          padding: 32,
          boxShadow: '0 20px 48px rgba(10,10,10,.10)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
          <Image src={logo} alt="Vorion" width={44} height={44} priority style={{ width: 44, height: 44, objectFit: 'contain' }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Forgot password</h1>
            <p style={{ margin: '6px 0 0', color: 'rgba(10,10,10,.58)', fontSize: 14 }}>
              We&apos;ll email you a secure link to reset your password.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: 14, fontWeight: 600, display: 'block', marginBottom: 8, color: '#111827' }}>Work email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoFocus
            autoComplete="email"
            placeholder="name@company.com"
            style={{
              width: '100%',
              padding: '12px 14px',
              borderRadius: 14,
              border: '1px solid rgba(10,10,10,.12)',
              background: '#FFFFFF',
              color: '#0A0A0A',
              fontSize: 14,
              marginBottom: 16,
              boxSizing: 'border-box',
            }}
          />

          {error ? (
            <div
              style={{
                fontSize: 13,
                color: '#B42318',
                background: 'rgba(180,35,24,.08)',
                border: '1px solid rgba(180,35,24,.2)',
                borderRadius: 12,
                padding: '10px 12px',
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          ) : null}

          {success ? (
            <div
              style={{
                fontSize: 13,
                color: '#0F766E',
                background: 'rgba(20,184,166,.10)',
                border: '1px solid rgba(20,184,166,.18)',
                borderRadius: 12,
                padding: '10px 12px',
                marginBottom: 16,
              }}
            >
              {success}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px 14px',
              borderRadius: 14,
              background: loading ? 'rgba(10,10,10,.08)' : '#0050B0',
              border: '1px solid #0050B0',
              color: '#FFFFFF',
              fontWeight: 700,
              fontSize: 14,
              cursor: loading ? 'not-allowed' : 'pointer',
              boxSizing: 'border-box',
            }}
          >
            {loading ? 'Sending reset link...' : 'Email me a reset link'}
          </button>
        </form>

        <div style={{ marginTop: 20, textAlign: 'center' }}>
          <Link href="/login" style={{ color: '#0050B0', fontSize: 14, fontWeight: 600, textDecoration: 'none' }}>
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
