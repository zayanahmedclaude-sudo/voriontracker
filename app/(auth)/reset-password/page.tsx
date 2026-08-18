'use client';

import { apiFetch } from '@/lib/api-client';
import { FormEvent, Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import logo from '@/public/vorion-logo-dark.png';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

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
      const response = await apiFetch<Response>('/api/auth/reset-password', {
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
          maxWidth: 1100,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 32,
          alignItems: 'stretch',
        }}
      >
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '32px 12px 32px 0',
          }}
        >
          <div
            style={{
              maxWidth: 540,
              padding: 32,
              borderRadius: 28,
              background: 'linear-gradient(180deg, rgba(255,255,255,.76), rgba(255,255,255,.48))',
              border: '1px solid rgba(255,255,255,.65)',
              boxShadow: '0 24px 64px rgba(15,23,42,.08)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
              <div
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: 18,
                  background: '#FFFFFF',
                  border: '1px solid rgba(10,10,10,.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 12px 28px rgba(10,10,10,.08)',
                }}
              >
                <Image src={logo} alt="Vorion" width={38} height={38} priority style={{ width: 38, height: 38, objectFit: 'contain' }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0050B0', letterSpacing: '.08em', textTransform: 'uppercase' }}>
                  Vorion
                </div>
                <h1 style={{ margin: '4px 0 0', fontSize: 38, lineHeight: 1.05, fontWeight: 800 }}>Reset your password</h1>
              </div>
            </div>

            <p style={{ margin: '0 0 16px', fontSize: 18, lineHeight: 1.55, color: 'rgba(10,10,10,.72)' }}>
              Create a new secure password to get back into your workspace.
            </p>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 12,
                marginTop: 24,
              }}
            >
              {[
                'Use at least 8 characters with uppercase, lowercase, number, and symbol.',
                'This reset link is time-limited for security.',
                'After saving, return to sign in with your new password.',
              ].map((item) => (
                <div
                  key={item}
                  style={{
                    padding: '14px 16px',
                    borderRadius: 18,
                    background: 'rgba(255,255,255,.72)',
                    border: '1px solid rgba(10,10,10,.08)',
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: 'rgba(10,10,10,.72)',
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          style={{
            background: '#FFFFFF',
            border: '1px solid rgba(10,10,10,.10)',
            borderRadius: 24,
            padding: 32,
            boxShadow: '0 20px 48px rgba(10,10,10,.10)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 16,
                background: 'rgba(0,80,176,.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#0050B0',
              }}
            >
              <ShieldCheck size={22} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Set a new password</h2>
              <p style={{ margin: '6px 0 0', color: 'rgba(10,10,10,.58)', fontSize: 14 }}>
                Choose a password for your Vorion account.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#111827' }}>New password</label>
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="new-password"
                placeholder="Enter a strong password"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '12px 44px 12px 14px',
                  borderRadius: 14,
                  border: '1px solid rgba(10,10,10,.12)',
                  background: '#FFFFFF',
                  color: '#0A0A0A',
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute',
                  right: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  border: 'none',
                  background: 'none',
                  color: 'rgba(10,10,10,.58)',
                  cursor: 'pointer',
                  padding: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#111827' }}>Confirm password</label>
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                autoComplete="new-password"
                placeholder="Re-enter your new password"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '12px 44px 12px 14px',
                  borderRadius: 14,
                  border: '1px solid rgba(10,10,10,.12)',
                  background: '#FFFFFF',
                  color: '#0A0A0A',
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword((value) => !value)}
                aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute',
                  right: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  border: 'none',
                  background: 'none',
                  color: 'rgba(10,10,10,.58)',
                  cursor: 'pointer',
                  padding: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            {error ? (
              <div
                style={{
                  marginBottom: 16,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'rgba(180,35,24,.08)',
                  border: '1px solid rgba(180,35,24,.18)',
                  color: '#B42318',
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            ) : null}

            {success ? (
              <div
                style={{
                  marginBottom: 16,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'rgba(20,184,166,.10)',
                  border: '1px solid rgba(20,184,166,.18)',
                  color: '#0F766E',
                  fontSize: 13,
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
                border: '1px solid #0050B0',
                background: loading ? 'rgba(10,10,10,.08)' : '#0050B0',
                color: '#FFFFFF',
                fontWeight: 700,
                fontSize: 14,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? 'Updating password...' : 'Update password'}
            </button>
          </form>

          <div style={{ marginTop: 20, textAlign: 'center' }}>
            <Link
              href="/login"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                color: '#0050B0',
                fontSize: 14,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              <ArrowLeft size={16} />
              Back to sign in
            </Link>
          </div>
        </section>
      </div>
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
