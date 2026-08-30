-- ============================================================================
-- Seed a development tenant for TVÅ's own testing (tvadevelopment.se).
-- Not a real student union — lets the team verify the login flow end-to-end
-- with their own accounts before onboarding an actual union.
-- ============================================================================

insert into tenant (name, primary_domain, allowed_identity_providers)
values ('TVÅ Development', 'tvadevelopment.se', array['google', 'microsoft']);
