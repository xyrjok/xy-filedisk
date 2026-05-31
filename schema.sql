CREATE TABLE IF NOT EXISTS admin (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    status          INTEGER DEFAULT 1 CHECK (status IN (0, 1)),
    created_at      INTEGER DEFAULT (strftime('%s', 'now')),
    last_login_at   INTEGER
);

CREATE TABLE tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    status INTEGER DEFAULT 1 CHECK(status IN (0,1)),
    access_token TEXT,
    expires_at INTEGER CHECK(expires_at IS NULL OR expires_at > 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
