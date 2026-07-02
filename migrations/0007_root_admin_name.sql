-- Ensure bootstrap admin display name is root
UPDATE users
SET name = 'root', updated_at = datetime('now')
WHERE id = (
  SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1
);
