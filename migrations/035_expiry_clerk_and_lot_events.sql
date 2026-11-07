-- PostgreSQL makes a new enum label unusable until the surrounding migration
-- transaction commits. The permission/table work therefore lives in 036.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'EXPIRY_CLERK';

INSERT INTO schema_migrations(version) VALUES ('035_expiry_clerk_and_lot_events');
