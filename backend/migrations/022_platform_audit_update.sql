-- The owner can now change a restaurant's name or login email from the owner console; that is part of the owner's record too.
ALTER TABLE platform_audit DROP CONSTRAINT platform_audit_action_check;
ALTER TABLE platform_audit
  ADD CONSTRAINT platform_audit_action_check CHECK (action IN ('create', 'update', 'suspend', 'reactivate', 'set_password', 'login_as', 'delete'));
