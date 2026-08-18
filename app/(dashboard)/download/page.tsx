'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { canViewAgentDownload, useAuthStore } from '@/store/auth';
import { normalizeRole } from '@/lib/roles';

const agentDownloadUrls = {
  win: process.env.NEXT_PUBLIC_AGENT_WINDOWS_DOWNLOAD_URL || process.env.NEXT_PUBLIC_AGENT_WIN_URL,
  mac: process.env.NEXT_PUBLIC_AGENT_MAC_URL,
  linux: process.env.NEXT_PUBLIC_AGENT_LINUX_URL,
};

const PAGE = {
  canvas: '#F7F8FB',
  surface: '#FFFFFF',
  soft: '#F2F5FA',
  ink: '#0A0A0A',
  muted: 'rgba(10,10,10,.58)',
  faint: 'rgba(10,10,10,.38)',
  border: 'rgba(10,10,10,.10)',
  borderStrong: 'rgba(0,80,176,.18)',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  shadow: '0 18px 48px rgba(15,23,42,.06)',
};

const platforms = [
  {
    id: 'win',
    label: 'Windows',
    badge: 'Desktop',
    url: agentDownloadUrls.win,
    description: 'Install the monitoring agent for Windows workstations.',
    steps: ['Download the installer package.', 'Run setup with administrator access.', 'Sign in and let the device sync.'],
    command: 'Start-Process .\\VorionAgentSetup.exe',
  },
  {
    id: 'mac',
    label: 'macOS',
    badge: 'Apple Silicon and Intel',
    url: agentDownloadUrls.mac,
    description: 'Deploy the agent on managed macOS devices with a quick onboarding flow.',
    steps: ['Download the `.dmg` package.', 'Move the app to Applications.', 'Grant screen recording permissions after launch.'],
    command: 'open /Volumes/VorionAgent/VorionAgent.app',
  },
  {
    id: 'linux',
    label: 'Linux',
    badge: 'Debian and Ubuntu',
    url: agentDownloadUrls.linux,
    description: 'Use the Linux build for engineering and operations environments.',
    steps: ['Download the package for your distro.', 'Install with package manager permissions.', 'Launch the service and verify device check-in.'],
    command: 'sudo dpkg -i vorion-agent.deb',
  },
];

const cardStyle: CSSProperties = {
  background: PAGE.surface,
  border: `1px solid ${PAGE.border}`,
  borderRadius: 28,
  boxShadow: PAGE.shadow,
};

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        ...cardStyle,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 116,
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: PAGE.faint,
        }}
      >
        {label}
      </span>
      <strong
        style={{
          fontSize: 28,
          lineHeight: 1.05,
          color: PAGE.ink,
        }}
      >
        {value}
      </strong>
    </div>
  );
}

export default function DownloadPage() {
  const router = useRouter();
  const { user, hasHydrated } = useAuthStore();
  const [copied, setCopied] = useState<string | null>(null);

  const role = normalizeRole(user?.role);
  const allowed = canViewAgentDownload(role);

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!allowed) {
      router.replace('/dashboard');
    }
  }, [allowed, hasHydrated, router, user]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!hasHydrated) {
    return null;
  }

  if (!user || !allowed) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: PAGE.canvas,
        }}
      >
        <div style={{ ...cardStyle, maxWidth: 520, padding: '28px 30px', textAlign: 'center' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '8px 14px',
              borderRadius: 999,
              background: PAGE.blueSoft,
              color: PAGE.blue,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              marginBottom: 18,
            }}
          >
            Access restricted
          </div>
          <h1 style={{ margin: 0, fontSize: 28, color: PAGE.ink }}>Download access is limited</h1>
          <p style={{ margin: '12px 0 0', fontSize: 15, lineHeight: 1.7, color: PAGE.muted }}>
            This area is available to authorized workspace roles only. If you should have access, contact your system
            administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: PAGE.canvas,
        color: PAGE.ink,
      }}
    >
      <div
        style={{
          maxWidth: 1320,
          margin: '0 auto',
          padding: '32px 24px 48px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <section
          style={{
            ...cardStyle,
            padding: '30px clamp(20px, 4vw, 40px)',
            background: `linear-gradient(135deg, ${PAGE.surface} 0%, #FBFDFF 72%, ${PAGE.blueSoft} 100%)`,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 24,
            }}
          >
            <div style={{ maxWidth: 760 }}>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  borderRadius: 999,
                  background: PAGE.blueSoft,
                  color: PAGE.blue,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                }}
              >
                Agent Distribution
              </div>
              <h1
                style={{
                  margin: '18px 0 10px',
                  fontSize: 'clamp(2rem, 4vw, 3.4rem)',
                  lineHeight: 1.02,
                  letterSpacing: '-.04em',
                  color: PAGE.ink,
                }}
              >
                Download Vorion Agent
              </h1>
              <p
                style={{
                  margin: 0,
                  maxWidth: 660,
                  fontSize: 16,
                  lineHeight: 1.75,
                  color: PAGE.muted,
                }}
              >
                Prepare employee devices with the latest monitored agent build. Choose the operating system, share the
                install steps, and keep deployment consistent across the workspace.
              </p>
            </div>

            <div
              style={{
                minWidth: 220,
                padding: '18px 20px',
                borderRadius: 24,
                border: `1px solid ${PAGE.borderStrong}`,
                background: PAGE.surface,
                boxShadow: '0 12px 28px rgba(0,80,176,.08)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: PAGE.faint }}>
                Deployment readiness
              </div>
              <div style={{ marginTop: 10, fontSize: 32, fontWeight: 800, lineHeight: 1, color: PAGE.ink }}>3 builds</div>
              <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.6, color: PAGE.muted }}>
                Windows, macOS, and Linux packages organized for faster IT rollout.
              </p>
            </div>
          </div>
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 18,
          }}
        >
          <SummaryCard label="Platforms" value="3" />
          <SummaryCard label="Access level" value="Authorized" />
          <SummaryCard label="Install support" value="Guided" />
        </section>

        <section
          style={{
            display: 'grid',
            gap: 20,
          }}
        >
          {platforms.map((platform) => {
            const isAvailable = Boolean(platform.url);

            return (
              <article
                key={platform.id}
                style={{
                  ...cardStyle,
                  padding: '24px clamp(18px, 3vw, 28px)',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: 24,
                    alignItems: 'start',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                      <h2 style={{ margin: 0, fontSize: 28, lineHeight: 1.1, color: PAGE.ink }}>{platform.label}</h2>
                      <span
                        style={{
                          padding: '7px 12px',
                          borderRadius: 999,
                          background: PAGE.soft,
                          color: PAGE.muted,
                          fontSize: 12,
                          fontWeight: 700,
                          letterSpacing: '.05em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {platform.badge}
                      </span>
                    </div>

                    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, color: PAGE.muted }}>{platform.description}</p>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
                      {isAvailable ? (
                        <a
                          href={platform.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '12px 18px',
                            borderRadius: 14,
                            background: PAGE.blue,
                            color: '#FFFFFF',
                            textDecoration: 'none',
                            fontSize: 14,
                            fontWeight: 700,
                            boxShadow: '0 14px 26px rgba(0,80,176,.18)',
                          }}
                        >
                          Download installer
                        </a>
                      ) : (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '12px 18px',
                            borderRadius: 14,
                            background: PAGE.soft,
                            color: PAGE.faint,
                            fontSize: 14,
                            fontWeight: 700,
                            border: `1px solid ${PAGE.border}`,
                          }}
                        >
                          Coming soon
                        </span>
                      )}

                      <button
                        type="button"
                        onClick={async () => {
                          await navigator.clipboard.writeText(platform.command);
                          setCopied(platform.id);
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '12px 18px',
                          borderRadius: 14,
                          background: PAGE.surface,
                          color: copied === platform.id ? PAGE.blue : PAGE.ink,
                          fontSize: 14,
                          fontWeight: 700,
                          border: `1px solid ${copied === platform.id ? PAGE.borderStrong : PAGE.border}`,
                          cursor: 'pointer',
                        }}
                      >
                        {copied === platform.id ? 'Copied command' : 'Copy install command'}
                      </button>
                    </div>
                  </div>

                  <div
                    style={{
                      padding: 20,
                      borderRadius: 22,
                      background: PAGE.soft,
                      border: `1px solid ${PAGE.border}`,
                      display: 'grid',
                      gap: 16,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          marginBottom: 10,
                          fontSize: 12,
                          fontWeight: 700,
                          letterSpacing: '.08em',
                          textTransform: 'uppercase',
                          color: PAGE.faint,
                        }}
                      >
                        Quick setup
                      </div>
                      <div style={{ display: 'grid', gap: 10 }}>
                        {platform.steps.map((step, index) => (
                          <div key={step} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                            <span
                              style={{
                                flexShrink: 0,
                                width: 24,
                                height: 24,
                                borderRadius: 999,
                                background: PAGE.surface,
                                border: `1px solid ${PAGE.border}`,
                                display: 'grid',
                                placeItems: 'center',
                                fontSize: 12,
                                fontWeight: 700,
                                color: PAGE.blue,
                              }}
                            >
                              {index + 1}
                            </span>
                            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: PAGE.muted }}>{step}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div
                        style={{
                          marginBottom: 10,
                          fontSize: 12,
                          fontWeight: 700,
                          letterSpacing: '.08em',
                          textTransform: 'uppercase',
                          color: PAGE.faint,
                        }}
                      >
                        Command
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          padding: '14px 16px',
                          borderRadius: 16,
                          background: PAGE.surface,
                          border: `1px solid ${PAGE.border}`,
                          color: PAGE.ink,
                          fontSize: 13,
                          lineHeight: 1.65,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          overflowX: 'auto',
                        }}
                      >
                        {platform.command}
                      </pre>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </section>

        <p style={{ margin: 0, padding: '0 2px', fontSize: 13, lineHeight: 1.7, color: PAGE.faint }}>
          Use the latest published installer links from your environment configuration to avoid distributing outdated
          agent packages.
        </p>
      </div>
    </div>
  );
}
