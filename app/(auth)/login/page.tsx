'use client';

import { apiFetch } from '@/lib/api-client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronDown, Eye, EyeOff, Laptop, MonitorDown, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import logo from '@/public/vorion-logo-dark.png';

const agentDownloadUrls = {
  win: process.env.NEXT_PUBLIC_AGENT_WINDOWS_DOWNLOAD_URL || process.env.NEXT_PUBLIC_AGENT_WIN_URL,
  mac: process.env.NEXT_PUBLIC_AGENT_MAC_URL,
  linux: process.env.NEXT_PUBLIC_AGENT_LINUX_URL,
};

const WEB_LAST_ACTIVITY_KEY = 'worktrack-last-activity-at';

const downloadPlatforms = [
  { id: 'win', name: 'Windows', url: agentDownloadUrls.win, icon: MonitorDown },
  { id: 'mac', name: 'macOS', url: agentDownloadUrls.mac, icon: Laptop },
  { id: 'linux', name: 'Linux', url: agentDownloadUrls.linux, icon: ShieldCheck },
];

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const { setAuth, user, token, hasHydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (hasHydrated && user && token) {
      router.replace('/dashboard');
    }
  }, [hasHydrated, router, token, user]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await apiFetch<Response>('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, context: 'web' }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      window.localStorage.setItem(WEB_LAST_ACTIVITY_KEY, String(Date.now()));
      setAuth(data.token, data.user);
      router.replace('/dashboard');
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
          maxWidth: 1120,
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
                <h1 style={{ margin: '4px 0 0', fontSize: 38, lineHeight: 1.05, fontWeight: 800 }}>Vorion Tracker</h1>
              </div>
            </div>

            <p style={{ margin: '0 0 16px', fontSize: 18, lineHeight: 1.55, color: 'rgba(10,10,10,.72)' }}>
              Sign in to manage your team and view activity across the workspace.
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
                'See live activity, screenshots, and timelines in one place.',
                'Keep employee monitoring and downloads in a secure workspace.',
                'Give admins and managers a clearer view of team operations.',
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
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
            <Image src={logo} alt="Vorion" width={44} height={44} priority style={{ width: 44, height: 44, objectFit: 'contain' }} />
            <div>
              <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Sign in</h2>
              <p style={{ margin: '6px 0 0', color: 'rgba(10,10,10,.58)', fontSize: 14 }}>
                Sign in to manage your workspace.
              </p>
            </div>
          </div>

          <form onSubmit={handleLogin}>
            <label style={{ fontSize: 14, fontWeight: 600, display: 'block', marginBottom: 8, color: '#111827' }}>Email</label>
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

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 8 }}>
              <label style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>Password</label>
              <Link
                href={email ? `/forgot-password?email=${encodeURIComponent(email)}` : '/forgot-password'}
                style={{
                  color: '#0050B0',
                  fontSize: 13,
                  fontWeight: 600,
                  padding: 0,
                  textDecoration: 'none',
                }}
              >
                Forgot password?
              </Link>
            </div>

            <div style={{ position: 'relative', marginBottom: 20 }}>
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                style={{
                  width: '100%',
                  padding: '12px 46px 12px 14px',
                  borderRadius: 14,
                  border: '1px solid rgba(10,10,10,.12)',
                  background: '#FFFFFF',
                  color: '#0A0A0A',
                  fontSize: 14,
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute',
                  right: 12,
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
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <div
            style={{
              marginTop: 24,
              paddingTop: 24,
              borderTop: '1px solid rgba(10,10,10,.10)',
            }}
          >
            <button
              type="button"
              onClick={() => setShowDownloads((value) => !value)}
              aria-expanded={showDownloads}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: '#111827',
              }}
            >
              <span style={{ textAlign: 'left' }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>Download the desktop agent</span>
                <span style={{ display: 'block', marginTop: 4, fontSize: 13, color: 'rgba(10,10,10,.58)' }}>
                  Windows, macOS, and Linux installers
                </span>
              </span>
              <ChevronDown
                size={18}
                style={{
                  transform: showDownloads ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform .2s ease',
                }}
              />
            </button>

            {showDownloads ? (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
                {downloadPlatforms.map((platform) => {
                  const Icon = platform.icon;
                  const sharedStyle = {
                    flex: '1 1 120px',
                    textAlign: 'center' as const,
                    padding: '14px 12px',
                    borderRadius: 16,
                    fontSize: 13,
                    fontWeight: 600,
                    display: 'flex',
                    flexDirection: 'column' as const,
                    alignItems: 'center' as const,
                    gap: 8,
                  };

                  if (platform.url) {
                    return (
                      <a
                        key={platform.id}
                        href={platform.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          ...sharedStyle,
                          textDecoration: 'none',
                          background: '#FFFFFF',
                          border: '1px solid rgba(10,10,10,.12)',
                          color: '#0A0A0A',
                        }}
                      >
                        <Icon size={20} />
                        <span>{platform.name}</span>
                      </a>
                    );
                  }

                  return (
                    <div
                      key={platform.id}
                      title={`${platform.name} download is coming soon`}
                      style={{
                        ...sharedStyle,
                        background: 'rgba(10,10,10,.03)',
                        border: '1px solid rgba(10,10,10,.08)',
                        color: 'rgba(10,10,10,.55)',
                      }}
                    >
                      <Icon size={20} />
                      <span>{platform.name}</span>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>Coming soon</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
