'use client';

import { apiFetch } from '@/lib/api-client';
// app/(dashboard)/layout.tsx
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  useAuthStore,
  canViewAgentDownload,
  canViewDepartmentManagement,
  canViewUserManagement,
  canMonitorAll,
  canViewSecurityPolicies,
  canViewFlags,
  canViewReports,
  getRoleLabel,
  type Role,
} from '@/store/auth';
import Image from 'next/image';
import vorionLogo from '@/public/vorion-logo-dark.png';

const WEB_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const WEB_LAST_ACTIVITY_KEY = 'worktrack-last-activity-at';

// ---- Vorion Brand Palette ----
const BRAND = {
  black: '#0A0A0A',
  blackSoft: '#F7F8FB',
  white: '#FFFFFF',
  ink: '#0A0A0A',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  yellow: '#0050B0',
  yellowSoft: 'rgba(0,80,176,.06)',
  border: 'rgba(10,10,10,.10)',
  muted: 'rgba(10,10,10,.58)',
  mutedFaint: 'rgba(10,10,10,.38)',
  danger: '#B42318',
};

const ROLE_COLOR: Record<Role, string> = {
  superadmin: BRAND.blue,
  admin: BRAND.blue,
  hr: BRAND.blue,
  executive: BRAND.blue,
  client: BRAND.blue,
  qa_manager: BRAND.blue,
  qa_lead: BRAND.yellow,
  qa: BRAND.blue,
  employee: BRAND.muted,
};

const NavItem = ({ href, label, show = true }: { href: string; label: string; show?: boolean }) => {
  const path = usePathname();
  if (!show) return null;
  const active = path === href || path.startsWith(href + '/');
  return (
    <Link href={href} style={{
      display: 'block', padding: '8px 12px', borderRadius: 8, fontSize: 13, marginBottom: 2,
      background: active ? BRAND.blueSoft : 'transparent',
      color: active ? BRAND.black : BRAND.muted,
      fontWeight: active ? 600 : 400,
      borderLeft: active ? `2px solid ${BRAND.blue}` : '2px solid transparent',
      transition: 'all .15s ease',
      textDecoration: 'none',
    }}>
      {label}
    </Link>
  );
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, token, logout, hasHydrated } = useAuthStore();
  const router = useRouter();
  const role = user?.role as Role;

  useEffect(() => {
    if (hasHydrated && (!user || !token)) {
      logout();
      router.replace('/login');
    }
  }, [hasHydrated, logout, router, token, user]);

  useEffect(() => {
    if (!hasHydrated || !token || !user) return;

    let cancelled = false;

    const validateSession = async () => {
      try {
        const response = await apiFetch<Response>('/api/auth', {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (cancelled) return;

        if (response.status === 401 || response.status === 403) {
          logout();
          router.replace('/login');
        }
      } catch {
        // Ignore transient validation failures and let page-level requests retry.
      }
    };

    void validateSession();

    return () => {
      cancelled = true;
    };
  }, [hasHydrated, logout, router, token, user]);

  useEffect(() => {
    if (!hasHydrated || !token || !user) return;

    let timeoutId: number | null = null;
    let loggedOut = false;

    const getLastActivityAt = () => {
      const storedValue = window.localStorage.getItem(WEB_LAST_ACTIVITY_KEY);
      const lastActivityAt = storedValue ? Number(storedValue) : 0;
      return Number.isFinite(lastActivityAt) && lastActivityAt > 0 ? lastActivityAt : Date.now();
    };

    const forceLogout = () => {
      if (loggedOut) return;
      loggedOut = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      window.localStorage.removeItem(WEB_LAST_ACTIVITY_KEY);
      logout();
      router.replace('/login');
    };

    const scheduleIdleCheck = () => {
      if (timeoutId) window.clearTimeout(timeoutId);

      const elapsed = Date.now() - getLastActivityAt();
      const remaining = WEB_IDLE_TIMEOUT_MS - elapsed;

      if (remaining <= 0) {
        forceLogout();
        return;
      }

      timeoutId = window.setTimeout(scheduleIdleCheck, remaining);
    };

    const markActivity = () => {
      if (loggedOut) return;
      window.localStorage.setItem(WEB_LAST_ACTIVITY_KEY, String(Date.now()));
      scheduleIdleCheck();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleIdleCheck();
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === WEB_LAST_ACTIVITY_KEY) {
        scheduleIdleCheck();
        return;
      }

      if (event.key !== 'worktrack-auth') return;

      if (!event.newValue) {
        forceLogout();
        return;
      }

      try {
        const authState = JSON.parse(event.newValue);
        if (!authState?.state?.token || !authState?.state?.user) {
          forceLogout();
        }
      } catch {
        forceLogout();
      }
    };

    if (!window.localStorage.getItem(WEB_LAST_ACTIVITY_KEY)) {
      markActivity();
    } else {
      scheduleIdleCheck();
    }

    const activityEvents: Array<keyof WindowEventMap> = ['click', 'keydown', 'mousemove', 'scroll', 'touchstart', 'focus'];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, markActivity, { passive: true }));
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('storage', handleStorage);

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, markActivity));
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, [hasHydrated, logout, router, token, user]);

  if (!hasHydrated || !user || !token) return null;
  const isClient = role === 'client';
  const isHr = role === 'hr';

  return (
    <div style={{
      display: 'flex', height: '100vh', overflow: 'hidden',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      background: BRAND.blackSoft, color: BRAND.black,
    }}>
      {/* Sidebar */}
      <aside style={{
        width: 220, flexShrink: 0,
        background: BRAND.white,
        borderRight: `1px solid ${BRAND.border}`,
        display: 'flex', flexDirection: 'column',
        padding: '20px 14px',
      }}>
        {/* Logo */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          marginBottom: 8, paddingLeft: 4, paddingBottom: 16,
          borderBottom: `1px solid ${BRAND.border}`,
        }}>
          <Image
            src={vorionLogo}
            alt="Vorion Logo"
            width={40}
            height={40}
            style={{ objectFit: 'contain' }}
          />
          <span style={{
            fontSize: 16, fontWeight: 700, color: BRAND.black, letterSpacing: '0.01em',
          }}>
            Vorion <span style={{ color: BRAND.yellow, fontWeight: 700 }}>Tracker</span>
          </span>
        </div>

        {/* Role badge */}
        <div style={{
          fontSize: 10, fontWeight: 700, padding: '4px 11px', borderRadius: 99,
          background: `${ROLE_COLOR[role]}18`, color: ROLE_COLOR[role],
          margin: '16px 0 18px', alignSelf: 'flex-start',
          border: `1px solid ${ROLE_COLOR[role]}40`,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {getRoleLabel(role)}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: BRAND.mutedFaint, padding: '4px 12px 8px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Monitor</div>
          <NavItem href="/dashboard"   label="Dashboard" />
          <NavItem href="/live"        label="Live Monitor"   show={canMonitorAll(role)} />
          <NavItem href="/screenshots" label="Screenshots" show={!isHr} />
          <NavItem href="/timeline"    label="Timeline" />
          <NavItem href="/flags"       label="Flagged Screenshots" show={canViewFlags(role)} />
          <div style={{ fontSize: 10, fontWeight: 700, color: BRAND.mutedFaint, padding: '18px 12px 8px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Reports</div>
          <NavItem href="/reports"     label="Reports" show={!isClient && canViewReports(role)} />
          <NavItem href="/access-logs" label="Access Log" show={role === 'superadmin'} />
          <NavItem href="/device-alerts" label="Device Alerts" show={canMonitorAll(role)} />
          <NavItem href="/security"    label="Security Policies" show={canViewSecurityPolicies(role)} />
          <NavItem href="/departments" label="Department Management" show={canViewDepartmentManagement(role)} />
          <NavItem href="/users"       label="User Management" show={canViewUserManagement(role)} />
          <NavItem href="/download"    label="Download Agent" show={canViewAgentDownload(role)} />
        </nav>

        {/* User footer */}
        <div style={{ borderTop: `1px solid ${BRAND.border}`, paddingTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2, color: BRAND.black }}>{user.name}</div>
          <div style={{ fontSize: 11, color: BRAND.mutedFaint, marginBottom: 10 }}>{user.email}</div>
          <button onClick={() => { window.localStorage.removeItem(WEB_LAST_ACTIVITY_KEY); logout(); router.replace('/login'); }} style={{
            fontSize: 12, color: BRAND.danger, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600,
          }}>
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main style={{
        flex: 1, overflow: 'auto', padding: 28,
        background: BRAND.blackSoft,
      }}>
        {children}
      </main>
    </div>
  );
}
