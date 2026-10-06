-- Phase 3: RustDesk (remote screen/GUI control) alongside the existing
-- SSH+Tailscale terminal access. Each client installer sets up RustDesk in
-- unattended mode (own generated password, no accept-popup) and reports its
-- RustDesk ID + password back to us once installed, same way it already
-- reports nothing for Tailscale today (we mint the Tailscale key ourselves,
-- but RustDesk's ID only exists after the client installs it, so it has to
-- report back).
ALTER TABLE clients ADD COLUMN rustdesk_id TEXT;
ALTER TABLE clients ADD COLUMN rustdesk_password TEXT;

-- Buyers' plan tier — used to gate paid-only features (e.g. self-heal /
-- auto-reinstall guardian) later. Everyone starts on 'free'; nothing reads
-- this yet except future self-heal code.
ALTER TABLE buyers ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
