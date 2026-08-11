'use client';
// app/(auth)/login/page.tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import Image from "next/image";
import logo from '@/public/vorion-logo-light.png';

const agentDownloadUrls = {
  win: process.env.NEXT_PUBLIC_AGENT_WINDOWS_DOWNLOAD_URL || process.env.NEXT_PUBLIC_AGENT_WIN_URL,
  mac: process.env.NEXT_PUBLIC_AGENT_MAC_URL,
  linux: process.env.NEXT_PUBLIC_AGENT_LINUX_URL,
};

const WEB_LAST_ACTIVITY_KEY = 'worktrack-last-activity-at';

const downloadPlatforms = [
  { id: 'win',   icon: '🪟', name: 'Windows', url: agentDownloadUrls.win },
  { id: 'mac',   icon: '🍎', name: 'macOS',   url: agentDownloadUrls.mac },
  { id: 'linux', icon: '🐧', name: 'Linux',   url: agentDownloadUrls.linux },
];

export default function LoginPage() {
  const [email,    setEmail]    = useState('admin@company.com');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const { setAuth, user, token, hasHydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (hasHydrated && user && token) {
      router.replace('/dashboard');
    }
  }, [hasHydrated, router, token, user]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError('');
    try {
      const res  = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, context: 'web' }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Login failed'); return; }
      window.localStorage.setItem(WEB_LAST_ACTIVITY_KEY, String(Date.now()));
      setAuth(data.token, data.user);
      router.replace('/dashboard');
    } catch { setError('Network error — is the server running?'); }
    finally  { setLoading(false); }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      background: 'radial-gradient(1200px 600px at 20% 0%, rgba(0,80,176,.22), transparent 60%), radial-gradient(900px 500px at 80% 20%, rgba(248,208,0,.12), transparent 55%), #0B0F1A',
      color: '#F8FAFC',
    }}>
      {/* Overrides Chrome/Edge's default white autofill background on inputs */}
      <style>{`
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus {
          -webkit-text-fill-color: #F8FAFC !important;
          -webkit-box-shadow: 0 0 0px 1000px rgba(20,26,40,1) inset !important;
          box-shadow: 0 0 0px 1000px rgba(20,26,40,1) inset !important;
          caret-color: #F8FAFC !important;
        }
      `}</style>
      <div style={{
        background: 'rgba(11,15,26,.82)', border: '1px solid rgba(248,250,252,.10)',
        backdropFilter: 'blur(16px)', borderRadius: 20,
        padding: '40px 36px', width: 380,
        boxShadow: '0 24px 60px rgba(0,0,0,.4)',
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Image
            src={logo}
            alt="Vorion"
            width={46}
            height={46}
            style={{ borderRadius: 20 }}
          />
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.02em' }}>Vorion Tracker</span>
        </div>
        <p style={{ color: 'rgba(248,250,252,.45)', fontSize: 13, marginBottom: 30 }}>Sign in to your workspace</p>

        <form onSubmit={handleLogin}>
          <label style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 5, color: 'rgba(248,250,252,.6)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Email</label>
          <input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoFocus style={{
            width: '100%', padding: '10px 12px', borderRadius: 12,
            border: '1px solid rgba(248,250,252,.12)', background: 'rgba(248,250,252,.05)',
            color: '#F8FAFC', fontSize: 13, marginBottom: 14, outline: 'none',
            boxSizing: 'border-box',
          }}/>

          <label style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 5, color: 'rgba(248,250,252,.6)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Password</label>
          <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={{
            width: '100%', padding: '10px 12px', borderRadius: 12,
            border: '1px solid rgba(248,250,252,.12)', background: 'rgba(248,250,252,.05)',
            color: '#F8FAFC', fontSize: 13, marginBottom: 18, outline: 'none',
            boxSizing: 'border-box',
          }}/>

          {error && (
            <div style={{ fontSize: 12, color: '#FF5C7A', background: 'rgba(255,92,122,.08)', border: '1px solid rgba(255,92,122,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '11px', borderRadius: 12,
            background: loading ? 'rgba(248,250,252,.1)' : 'linear-gradient(180deg, rgba(0,80,176,.7), rgba(0,80,176,.5))',
            border: '1px solid rgba(0,80,176,.6)',
            color: '#F8FAFC', fontWeight: 700, fontSize: 13, cursor: loading ? 'not-allowed' : 'pointer',
            boxSizing: 'border-box',
          }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p style={{ fontSize: 11, color: 'rgba(248,250,252,.2)', textAlign: 'center', marginTop: 22 }}>
          Default: admin@vorion.com / admin123
        </p>

        {/* Agent download section */}
        <div style={{
          marginTop: 22, paddingTop: 18,
          borderTop: '1px solid rgba(248,250,252,.08)',
        }}>
          <p style={{
            fontSize: 11, fontWeight: 600, color: 'rgba(248,250,252,.4)',
            textAlign: 'center', marginBottom: 12,
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Download Vorion Agent
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {downloadPlatforms.map(p => (
              p.url ? (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    flex: 1, textAlign: 'center', padding: '10px 8px',
                    borderRadius: 12, textDecoration: 'none',
                    background: 'rgba(248,250,252,.05)',
                    border: '1px solid rgba(248,250,252,.12)',
                    color: '#F8FAFC', fontSize: 12, fontWeight: 600,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    transition: 'all .2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(37,99,235,.15)';
                    e.currentTarget.style.borderColor = 'rgba(37,99,235,.4)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(248,250,252,.05)';
                    e.currentTarget.style.borderColor = 'rgba(248,250,252,.12)';
                  }}
                >
                  <span style={{ fontSize: 18 }}>{p.icon}</span>
                  {p.name}
                </a>
              ) : (
                <span
                  key={p.id}
                  style={{
                    flex: 1, textAlign: 'center', padding: '10px 8px',
                    borderRadius: 12,
                    background: 'rgba(248,250,252,.03)',
                    border: '1px solid rgba(248,250,252,.08)',
                    color: 'rgba(248,250,252,.3)', fontSize: 12, fontWeight: 600,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{p.icon}</span>
                  {p.name}
                </span>
              )
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
