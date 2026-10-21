CREATE TABLE inpatient_record_number (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, patient_id TEXT NOT NULL, record_number TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,patient_id), UNIQUE(workspace_id,epoch,record_number),
  FOREIGN KEY(workspace_id,epoch) REFERENCES workspace_epoch(workspace_id,epoch) ON DELETE RESTRICT
) STRICT;
INSERT INTO inpatient_record_number SELECT DISTINCT workspace_id,epoch,patient_id,'MR-' || lower(hex(randomblob(16))) FROM inpatient_admission GROUP BY workspace_id,epoch,patient_id;
CREATE TABLE inpatient_record_revision (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  sources_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
  actor_id TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,admission_id,revision),
  FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_record_review (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL, review_id TEXT NOT NULL, revision INTEGER NOT NULL,
  sources_hash TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('approved','returned')), reason TEXT,
  actor_id TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,review_id), UNIQUE(workspace_id,epoch,admission_id,review_id),
  CHECK(outcome<>'returned' OR reason IS NOT NULL),
  FOREIGN KEY(workspace_id,epoch,admission_id,revision) REFERENCES inpatient_record_revision(workspace_id,epoch,admission_id,revision) ON DELETE RESTRICT
) STRICT;
CREATE TABLE inpatient_record_archive (
  workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, admission_id TEXT NOT NULL, archive_id TEXT NOT NULL, revision INTEGER NOT NULL,
  review_id TEXT NOT NULL, sources_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  actor_id TEXT NOT NULL, practitioner_role_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,epoch,admission_id), UNIQUE(workspace_id,epoch,archive_id),
  FOREIGN KEY(workspace_id,epoch,admission_id,revision) REFERENCES inpatient_record_revision(workspace_id,epoch,admission_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,epoch,admission_id,review_id) REFERENCES inpatient_record_review(workspace_id,epoch,admission_id,review_id) ON DELETE RESTRICT
) STRICT;
