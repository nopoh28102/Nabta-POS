ALTER TABLE branches ADD COLUMN IF NOT EXISTS receipt_phone text NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN IF NOT EXISTS whatsapp_phone text NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN IF NOT EXISTS social_handle text NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN IF NOT EXISTS receipt_footer text NOT NULL DEFAULT 'شكراً لزيارتكم';
ALTER TABLE branches ADD COLUMN IF NOT EXISTS logo_data_url text NOT NULL DEFAULT '';
