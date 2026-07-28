DROP INDEX IF EXISTS idx_users_allowed_google_email;
DROP INDEX IF EXISTS idx_users_allowed_microsoft_email;
ALTER TABLE users DROP COLUMN allowed_google_email;
ALTER TABLE users DROP COLUMN allowed_microsoft_email;
ALTER TABLE system_config DROP COLUMN registration_enabled;