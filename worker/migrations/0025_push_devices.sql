-- Push notification device registrations (APNs for iOS, FCM-ready for later).
-- One row per device token. Notification preferences live per-device so each
-- device chooses what wakes it. Defaults mirror the product decision: the
-- "silent" events you'd otherwise never see (blocked mail, dead destinations)
-- are on; the events that already land in your inbox (forwards, reply receipts)
-- are opt-in.
CREATE TABLE push_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL DEFAULT 'ios',
  token TEXT NOT NULL UNIQUE,
  notify_blocked INTEGER NOT NULL DEFAULT 1,
  notify_bounce  INTEGER NOT NULL DEFAULT 1,
  notify_forward INTEGER NOT NULL DEFAULT 0,
  notify_reply   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX idx_push_devices_user ON push_devices(user_id);
