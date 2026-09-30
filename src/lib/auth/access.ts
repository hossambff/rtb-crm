import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";

/**
 * Better Auth admin-plugin roles (user management only: list/ban/impersonate/set-role).
 * App-level authorization is our own Module × Action × Scope engine in src/lib/rbac.
 *
 * SEC H-1: only `super_admin` holds Better Auth admin statements. The app's `admin` (RevOps) role manages users
 * exclusively through the guarded, audited server actions in src/lib/admin/users-actions.ts, which perform the
 * writes server-side (src/lib/auth/admin-ops.ts) after the app's own checks — never through /api/auth/admin/*.
 */
export const ac = createAccessControl(defaultStatements);

const superAdmin = ac.newRole({ ...adminAc.statements });
const user = ac.newRole({ ...userAc.statements });

export const authRoles = {
  super_admin: superAdmin,
  admin: user,
  executive: user,
  sales_leader: user,
  ae: user,
  sdr: user,
  intern: user,
  commission_rep: user,
  onboarding: user,
  finance: user,
  editorial: user,
  viewer: user,
  pending: user,
};
