PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  telegram_id TEXT UNIQUE,
  reminders_enabled INTEGER NOT NULL DEFAULT 1,
  connect_code_hash TEXT UNIQUE,
  connect_code_expires INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Phone numbers are kept in the private D1 database, not in GitHub.
CREATE TABLE IF NOT EXISTS employee_phones (
  employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_date TEXT NOT NULL,
  starts_at TEXT NOT NULL DEFAULT '08:00',
  ends_at TEXT NOT NULL DEFAULT '08:00',
  team_name TEXT NOT NULL DEFAULT 'Зміна',
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(shift_date) = 10)
);

CREATE TABLE IF NOT EXISTS shift_members (
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (shift_id, employee_id)
);

CREATE TABLE IF NOT EXISTS reminder_log (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_date TEXT NOT NULL,
  reminder_type TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id, shift_date, reminder_type)
);

CREATE TABLE IF NOT EXISTS login_failures (
  client_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_shift_members_employee ON shift_members(employee_id);
CREATE INDEX IF NOT EXISTS idx_reminder_date ON reminder_log(shift_date);
