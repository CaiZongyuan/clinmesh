DROP INDEX laboratory_request_active_item_unique;

CREATE UNIQUE INDEX laboratory_request_active_item_unique
  ON laboratory_request (workspace_id, epoch, case_id, catalog_item_id)
  WHERE status IN ('issued', 'accepted', 'in-progress');
