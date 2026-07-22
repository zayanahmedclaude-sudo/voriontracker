'use client';
// store/auth.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  canManageSecurity,
  canManageUsers as canManageUsersByRole,
  canMonitorAll as canMonitorAllByRole,
  canViewAgentDownload as canViewAgentDownloadByRole,
  canViewDepartmentManagement as canViewDepartmentManagementByRole,
  canViewSecurity as canViewSecurityByRole,
  canViewUserManagement as canViewUserManagementByRole,
  canViewReports as canViewReportsByRole,
  canSendAlerts as canSendAlertsByRole,
  canViewFlags as canViewFlagsByRole,
  normalizeRole,
  roleLabel,
  type Role,
} from '@/lib/roles';
export type { Role } from '@/lib/roles';

export interface AuthUser { id:string; name:string; email:string; role:Role; teamId:string|null; }

interface AuthState {
  token: string|null; user: AuthUser|null; hasHydrated: boolean;
  setAuth: (token:string, user:AuthUser) => void;
  logout: () => void;
  setHydrated: (hydrated: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      hasHydrated: false,
      setAuth: (token, user) => {
        const normalizedUser = user ? { ...user, role: normalizeRole(user.role) } : null;
        set({ token, user: normalizedUser });
      },
      logout: () => set({ token: null, user: null }),
      setHydrated: (hasHydrated) => set({ hasHydrated }),
    }),
    {
      name: 'worktrack-auth',
      partialize: (state) => ({ token: state.token, user: state.user }),
      onRehydrateStorage: () => (state) => {
        const hasCompleteSession = Boolean(state?.token && state?.user);
        if (!hasCompleteSession && (state?.token || state?.user)) {
          state?.logout();
        }
        state?.setHydrated(true);
      },
    }
  )
);

const LEVELS: Record<Role,number> = { superadmin:8, admin:7, hr:6, executive:5, qa_manager:4, qa_lead:3, qa:2, client:1, employee:0 };
export const canMonitorAll  = (r:Role) => canMonitorAllByRole(r);
export const canManageUsers = (r:Role) => canManageUsersByRole(r);
export const canViewUserManagement = (r:Role) => canViewUserManagementByRole(r);
export const canViewDepartmentManagement = (r:Role) => canViewDepartmentManagementByRole(r);
export const canViewReports = (r:Role) => canViewReportsByRole(r);
export const canSendAlerts  = (r:Role) => canSendAlertsByRole(r);
export const canManageSecurityPolicies = (r: Role) => canManageSecurity(r);
export const canViewSecurityPolicies = (r: Role) => canViewSecurityByRole(r);
export const canViewAgentDownload = (r: Role) => canViewAgentDownloadByRole(r);
export const canViewFlags = (r: Role) => canViewFlagsByRole(r);
export const getRoleLabel = (r: Role) => roleLabel(r);
export const isAtLeast      = (r:Role,min:Role) => LEVELS[r]>=LEVELS[min];
