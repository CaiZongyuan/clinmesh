CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX session_user_id_idx ON session (user_id);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user (id) ON DELETE CASCADE,
  UNIQUE (issuer, account_id)
) STRICT;

CREATE INDEX account_user_id_idx ON account (user_id);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX verification_identifier_idx ON verification (identifier);

CREATE TABLE workspace_membership (
  membership_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_id),
  UNIQUE (workspace_id, actor_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES user (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX workspace_membership_user_idx
  ON workspace_membership (user_id, status, workspace_id);

CREATE TABLE practitioner_role_binding (
  workspace_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  practitioner_id TEXT NOT NULL,
  role_code TEXT NOT NULL CHECK (
    role_code IN ('registrar', 'triage-nurse', 'outpatient-doctor', 'cashier', 'pharmacist', 'administrator')
  ),
  organization_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (workspace_id, practitioner_role_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace (workspace_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE membership_practitioner_role (
  membership_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  PRIMARY KEY (membership_id, practitioner_role_id),
  FOREIGN KEY (membership_id) REFERENCES workspace_membership (membership_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, practitioner_role_id)
    REFERENCES practitioner_role_binding (workspace_id, practitioner_role_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE auth_session_context (
  session_id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL,
  practitioner_role_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES session (id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, practitioner_role_id)
    REFERENCES membership_practitioner_role (membership_id, practitioner_role_id) ON DELETE CASCADE
) STRICT;
