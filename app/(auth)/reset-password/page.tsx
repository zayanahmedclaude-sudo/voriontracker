'use client';

import { FormEvent, Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');

    if (!token) {
      setError('Reset token is missing from this link.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error || 'Failed to reset password.');
        return;
      }
      setSuccess('Password updated. You can sign in now.');
      setPassword('');
      setConfirmPassword('');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      background: 'radial-gradient(900px 500px at 20% 0%, rgba(0,80,176,.18), transparent 60%), #0B0F1A',
      color: '#F8FAFC',
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 28,
          borderRadius: 20,
          border: '1px solid rgba(248,250,252,.1)',
          background: 'rgba(11,15,26,.82)',
          boxShadow: '0 24px 60px rgba(0,0,0,.35)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>Reset Password</h1>
        <p style={{ marginTop: 8, marginBottom: 20, color: 'rgba(248,250,252,.55)', fontSize: 14 }}>
          Choose a new password for your Vorion account.
        </p>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>New password</label>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid rgba(248,250,252,.12)',
            background: 'rgba(248,250,252,.05)',
            color: '#F8FAFC',
            marginBottom: 14,
          }}
        />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Confirm password</label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid rgba(248,250,252,.12)',
            background: 'rgba(248,250,252,.05)',
            color: '#F8FAFC',
            marginBottom: 14,
          }}
        />

        {error ? (
          <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,92,122,.1)', color: '#FF5C7A' }}>
            {error}
          </div>
        ) : null}

        {success ? (
          <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(45,212,191,.12)', color: '#7DE2D1' }}>
            {success}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid rgba(0,80,176,.6)',
            background: loading ? 'rgba(248,250,252,.1)' : 'linear-gradient(180deg, rgba(0,80,176,.75), rgba(0,80,176,.55))',
            color: '#F8FAFC',
            fontWeight: 700,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
