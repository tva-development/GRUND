-- ============================================================================
-- Local development seed. Runs on `npx supabase db reset`, not on start.
--
-- handle_new_auth_user() matches a new signup's email domain against
-- tenant.primary_domain. With no matching tenant it creates no app_user row
-- and raises nothing — every RLS policy then evaluates false and the app looks
-- empty with no error. This tenant is what makes a local sign-in usable.
--
-- Not a real student union: it exists so the team can verify the login flow
-- end-to-end with their own accounts before onboarding an actual union.
-- ============================================================================

insert into tenant (name, primary_domain, allowed_identity_providers)
values ('TVÅ Development', 'tvadevelopment.se', array['google', 'microsoft'])
on conflict (primary_domain) do nothing;
