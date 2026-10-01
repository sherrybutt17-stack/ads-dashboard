import { describe, it, expect } from "vitest";
import { assignableRoles, isOperatorRole, isPlatformRole, mayAdminister } from "./roles";
import { userRoleEnum, type UserRole } from "@/db/schema";
import { SESSION_ROLES } from "./session";

/*
 * Who may hand out which role.
 *
 * 🔴 This is the escalation surface of the whole tenancy model. Every other
 * boundary — scoped accessors, `requireClient`, the proxy — asks "does this
 * session's agency own this row". A role handed upward answers that question
 * differently forever after: an `agency` operator who can mint a `staff` login
 * has not bypassed one check, they have left their tenancy through the ordinary
 * "add a teammate" form, and every subsequent access is legitimately authorized.
 */

const ALL = [...userRoleEnum.enumValues] as UserRole[];

describe("assignableRoles", () => {
  it("🔴 an agency operator cannot mint a role that sees other agencies", () => {
    const granted = assignableRoles("agency");
    expect(granted).not.toContain("superadmin");
    // `staff` is the pre-tenancy role and means "every row in the database".
    // Handing it out is handing out the platform.
    expect(granted).not.toContain("staff");
  });

  it("an agency operator can staff their own team", () => {
    const granted = assignableRoles("agency");
    expect(granted).toContain("agency");
    expect(granted).toContain("client");
  });

  it("the platform tier can assign anything", () => {
    for (const creator of ["staff", "superadmin"] as const) {
      expect([...assignableRoles(creator)].sort()).toEqual([...ALL].sort());
    }
  });

  it("🔴 a client-role user can assign nothing at all", () => {
    // Not merely "is denied by the route" — the rule itself has to be empty, or
    // a future caller that forgets the role check inherits a working escalation.
    expect(assignableRoles("client")).toEqual([]);
    expect(assignableRoles(undefined)).toEqual([]);
  });

  it("🔴 never returns a role the database cannot store", () => {
    /*
     * A typo here would not be caught by the compiler on the way in — the value
     * reaches Postgres as an enum literal and fails at INSERT, at the end of a
     * form submission, with a constraint error rather than a message.
     */
    for (const creator of ALL) {
      for (const granted of assignableRoles(creator)) {
        expect(ALL, `${creator} may assign unknown role ${granted}`).toContain(
          granted,
        );
      }
    }
  });

  it("🔴 nobody can assign a role that no longer exists in the enum", () => {
    // Guards the reverse drift: dropping a value from `userRoleEnum` without
    // touching this table leaves a role the form offers and the database
    // refuses. Every role in the enum is also a valid session role.
    expect([...SESSION_ROLES].sort()).toEqual([...ALL].sort());
  });

  it("is strictly downward — nobody assigns above themselves", () => {
    /*
     * The invariant behind all of the above, stated once. `staff` is the
     * exception the codebase currently carries: it sits at the platform tier
     * despite its name, because that is what it has always meant.
     */
    const rank: Record<UserRole, number> = {
      client: 0,
      agency: 1,
      superadmin: 2,
      staff: 2,
    };
    for (const creator of ALL) {
      for (const granted of assignableRoles(creator)) {
        expect(
          rank[granted],
          `${creator} may assign ${granted}, which outranks it`,
        ).toBeLessThanOrEqual(rank[creator]);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * The tier predicates
 * ------------------------------------------------------------------ */

/*
 * 🔴 Enumerated over the WHOLE enum, not spot-checked.
 *
 * The bug these exist to prevent was a role the code had simply never heard of:
 * `authorizeLayoutWrite` and `authorizeClientBrandingWrite` both asked
 * `role === "staff"` because that was the only operator role when they were
 * written, and answered "no" for `agency` ever after. Listing every value means
 * the next role added to the enum forces a decision here rather than silently
 * inheriting "not an operator".
 */
describe("tier predicates", () => {
  const OPERATORS: UserRole[] = ["staff", "agency", "superadmin"];
  const PLATFORM: UserRole[] = ["staff", "superadmin"];

  it("covers every role in the enum, so a new one cannot slip through", () => {
    expect([...ALL].sort()).toEqual([...new Set([...OPERATORS, "client"])].sort());
  });

  it("isOperatorRole is true for exactly the operator roles", () => {
    for (const role of ALL) {
      expect({ role, operator: isOperatorRole(role) }).toEqual({
        role,
        operator: OPERATORS.includes(role),
      });
    }
  });

  it("isPlatformRole is true for exactly the cross-agency roles", () => {
    for (const role of ALL) {
      expect({ role, platform: isPlatformRole(role) }).toEqual({
        role,
        platform: PLATFORM.includes(role),
      });
    }
  });

  it("🔴 an agency operator is an operator but NOT platform-wide", () => {
    // The distinction the whole tenancy model rests on: they run their own
    // book, and must never read across the boundary.
    expect(isOperatorRole("agency")).toBe(true);
    expect(isPlatformRole("agency")).toBe(false);
  });

  it("treats undefined and unknown strings as neither", () => {
    // A role that fell out of a malformed session token must not be an
    // operator by default.
    for (const bogus of [undefined, "", "admin", "STAFF"]) {
      expect(isOperatorRole(bogus)).toBe(false);
      expect(isPlatformRole(bogus)).toBe(false);
    }
  });
});

describe("🔴 mayAdminister — managing a login is as powerful as creating it", () => {
  /*
   * The escalation it closes: an `agency` operator could not CREATE a
   * superadmin, but could reset the password of the superadmin in their own
   * agency and sign in as them. Taking over a login must need the same rank as
   * making one.
   */
  it("refuses an agency operator any platform login", () => {
    expect(mayAdminister("agency", "superadmin")).toBe(false);
    expect(mayAdminister("agency", "staff")).toBe(false);
  });

  it("lets an agency operator manage their own tier and clients", () => {
    expect(mayAdminister("agency", "agency")).toBe(true);
    expect(mayAdminister("agency", "client")).toBe(true);
  });

  it("lets the platform tier manage everyone", () => {
    for (const caller of ["superadmin", "staff"] as const) {
      for (const target of ["superadmin", "staff", "agency", "client"] as const) {
        expect(mayAdminister(caller, target), `${caller} → ${target}`).toBe(true);
      }
    }
  });

  it("gives a client, or nobody, nothing to manage", () => {
    for (const target of ["superadmin", "staff", "agency", "client"] as const) {
      expect(mayAdminister("client", target)).toBe(false);
      expect(mayAdminister(undefined, target)).toBe(false);
    }
  });

  it("agrees with assignableRoles everywhere, so the two cannot drift", () => {
    const roles = ["superadmin", "staff", "agency", "client"] as const;
    for (const caller of [...roles, undefined]) {
      for (const target of roles) {
        expect(mayAdminister(caller, target)).toBe(assignableRoles(caller).includes(target));
      }
    }
  });
});
