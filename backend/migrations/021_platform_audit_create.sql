-- Restaurants are now created only by the platform owner (from the owner console), so that is part of the owner's record too.
ALTER TABLE platform_audit DROP CONSTRAINT platform_audit_action_check;
ALTER TABLE platform_audit
  ADD CONSTRAINT platform_audit_action_check CHECK (action IN ('create', 'suspend', 'reactivate', 'set_password', 'login_as', 'delete'));
