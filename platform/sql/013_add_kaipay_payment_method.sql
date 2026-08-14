-- Add the new provider value in its own committed migration. PostgreSQL enum
-- values cannot be safely consumed in the same transaction that creates them.
-- Historical ALIPAY rows remain readable; all new application writes use
-- KAIPAY exclusively.

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'KAIPAY';
