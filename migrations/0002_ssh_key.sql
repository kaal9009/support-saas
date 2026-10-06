-- Phase 2: each buyer provides their own SSH public key (not Rohit's personal one).
-- It gets written into every client install script so only that buyer — or the
-- master admin, during an explicitly-consented escalation — can SSH in.
ALTER TABLE buyers ADD COLUMN ssh_public_key TEXT;
