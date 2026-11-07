---
title: Roles, permissions and admin screens (RBAC)
summary: Data model, permission strings, deny-by-default guards, ownership rules, admin UI for roles, protecting the last admin, audit trail, tests.
agents: backend, frontend, security, database, testing, coder
triggers: admin, admins, administrator, role, roles, permission, permissions, rbac, acl, staff, moderator, manager, owner, access control, superuser, back office, backoffice
---
# Roles, permissions and admin screens (RBAC)

Building blocks: `rbac-ts`, `rbac-py` and `audit-log-ts` (list_blocks). Use them, then wire them to the project's database and routes.

## Data model
```sql
create table roles (id bigint generated always as identity primary key, name text not null unique,
                    description text not null default '', is_system boolean not null default false);
create table permissions (id bigint generated always as identity primary key, key text not null unique,  -- 'booking:read'
                          description text not null default '');
create table role_permissions (role_id bigint references roles(id) on delete cascade,
                               permission_id bigint references permissions(id) on delete cascade,
                               primary key (role_id, permission_id));
create table user_roles (user_id bigint references users(id) on delete cascade,
                         role_id bigint references roles(id) on delete restrict,
                         primary key (user_id, role_id));
create table audit_log (id bigint generated always as identity primary key, actor_id bigint references users(id),
                        action text not null, target_type text not null, target_id text not null,
                        before jsonb, after jsonb, ip inet, created_at timestamptz not null default now());
create index audit_log_target_idx on audit_log (target_type, target_id, created_at desc);
```
A single `role` column on users is acceptable for tiny apps with fixed roles, but the moment admins should "create roles" or "grant permissions", use the tables above.

## Permissions, not role names, in code
- Permission keys as `resource:action`, optionally with scope: `booking:read`, `booking:read:any`, `booking:update:own`, `user:manage`, `role:manage`, `report:export`.
- Code checks permissions (`require("booking:cancel")`); roles are just named bundles that admins can change without a deploy.
- Seed system roles and permissions in a migration or seed script: `admin` (everything), `staff` (operational), `member` (own data). Mark them `is_system` so they cannot be deleted.

## Enforcement on the server (deny by default)
```python
def require(permission: str):
    def dep(user: CurrentUser, db: DbSession) -> User:
        if permission not in permissions_for(db, user.id):   # cache per request
            raise AppError(403, "You do not have permission to do this.")
        return user
    return Depends(dep)

@router.delete("/users/{user_id}", status_code=204, dependencies=[require("user:manage")])
def delete_user(user_id: int, actor: CurrentUser, db: DbSession): ...
```
```ts
export const requirePermission = (perm: string) => (req: Request, _res: Response, next: NextFunction) =>
  req.user?.permissions.includes(perm) ? next() : next(new AppError(403, "You do not have permission to do this."));
```
- Every route declares its permission or is explicitly public; add a test that lists all routes and fails if one has neither.
- Object-level rules in services: `booking:update:own` allows only `booking.user_id == actor.id`; `:any` allows all. Load records with the owner filter so a forbidden record looks like 404.
- Multi-tenant apps add the tenant (organisation) to every query and every permission check.
- Put permissions (or the role ids) in the session or token only as a cache; re-check on sensitive actions or keep tokens short-lived so revocations apply quickly.

## Admin UI
- Users page: table with search, role filter, pagination; actions: invite or create user, assign roles, disable account, reset password.
- Roles page: list roles with user counts; create role (name, description); edit permissions as a grid of checkboxes grouped by resource with plain descriptions ("Cancel any booking"); system roles cannot be deleted.
- Confirm destructive changes in a dialog naming the effect ("Remove the Admin role from Sara? She will lose access to user management.").
- Guard rails: a user cannot remove their own admin role or disable themselves; the last user with `role:manage` cannot lose it (check in the service inside a transaction).
- Audit page: who changed what and when, filterable by user and target, read-only.

## Permission-aware frontend
Fetch the current user with permissions (`GET /me` returns `{ id, name, permissions: [...] }`). A `<Can permission="user:manage">` component or `can("user:manage")` helper hides or disables actions and admin navigation. This is only for usability: the server enforces every rule.

## Audit trail
Write an audit row in the same transaction as every sensitive change: role created, permissions granted or revoked, roles assigned, user disabled, password reset by admin, data exported. Store before and after (without secrets), the actor and the IP. Never let the API update or delete audit rows.

## Tests
A matrix test: for each role (anonymous, member, staff, admin) and each protected route, the expected status (401, 403, 200 or 204). Plus: owner can edit own booking, another member gets 404; admin cannot remove their own admin role; the last admin cannot be demoted; permission changes write audit rows; a new role with only `report:export` can export and nothing else.
