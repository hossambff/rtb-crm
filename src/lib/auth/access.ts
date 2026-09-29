import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";

/**
 * Better Auth admin-plugin roles (user management only: list/ban/impersonate/set-role).
 * App-level authorization is our own Module × Action × Scope engine in src/lib/rbac.
 */
export const ac = createAccessControl(defaultStatements);

const admin = ac.newRole({ ...adminAc.statements });
const user = ac.newRole({ ...userAc.statements });

export const authRoles = {
  super_admin: admin,
  admin,
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
