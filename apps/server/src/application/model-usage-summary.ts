// Cache and reasoning counters are subsets, not additional consumption.
const knownInputTokens = `COALESCE(json_extract(record_json, '$.usage.inputTokens'),
    CASE WHEN json_extract(record_json, '$.usage.raw.format') = 'dsh' THEN
      COALESCE(json_extract(record_json, '$.usage.raw.uncachedInputTokens'), 0)
      + COALESCE(json_extract(record_json, '$.usage.raw.cacheReadTokens'), 0)
      + COALESCE(json_extract(record_json, '$.usage.raw.cacheWriteTokens'), 0)
    ELSE json_extract(record_json, '$.usage.cachedInputTokens') END, 0)`
const knownOutputTokens = `COALESCE(json_extract(record_json, '$.usage.outputTokens'), json_extract(record_json, '$.usage.reasoningOutputTokens'), 0)`
const knownTokens = `COALESCE(json_extract(record_json, '$.accounting.totalTokens'), json_extract(record_json, '$.usage.totalTokens'),
  ${knownInputTokens} + ${knownOutputTokens})`
const actualRequest = `COALESCE(json_extract(record_json, '$.dispatch'), 'unknown') != 'not-dispatched'`
export const liveModelUsageSql = `SELECT attempt_id, workspace_id, epoch, case_id,
  json_extract(record_json, '$.context.taskId') AS task_id, json_extract(record_json, '$.context.stage') AS stage, feature, provider,
  requested_model, actual_model, status, started_at, date(started_at, '+8 hours') AS date,
  (${actualRequest}) AS requests, (status = 'in-flight') AS inFlight, (status = 'unknown') AS unknownRequests,
  ${knownTokens} AS knownTokens,
  ${knownInputTokens} AS knownInputTokens, ${knownOutputTokens} AS knownOutputTokens,
  ((${actualRequest}) AND json_extract(record_json, '$.usage.inputTokens') IS NULL) AS unknownInputTokenRequests,
  ((${actualRequest}) AND json_extract(record_json, '$.usage.outputTokens') IS NULL) AS unknownOutputTokenRequests,
  ((${actualRequest}) AND COALESCE(json_extract(record_json, '$.accounting.totalTokens'), json_extract(record_json, '$.usage.totalTokens')) IS NULL) AS unknownTokenRequests,
  COALESCE(json_extract(record_json, '$.effectiveCost.cnyMicro'), json_extract(record_json, '$.cost.cnyMicro')) AS cnyMicro,
  ((${actualRequest}) AND COALESCE(json_extract(record_json, '$.effectiveCost.cnyMicro'), json_extract(record_json, '$.cost.cnyMicro')) IS NULL) AS unpricedRequests
  FROM model_usage_attempt`

export const combinedModelUsageSql = `WITH usage AS (${liveModelUsageSql} UNION ALL
  SELECT NULL, workspace_id, epoch, NULLIF(case_id, ''), task_id, stage, feature, provider, requested_model, NULLIF(actual_model, ''), status,
    strftime('%Y-%m-%dT%H:%M:%fZ', date || 'T00:00:00+08:00'), date,
    requests, 0, unknown_requests, known_tokens, known_input_tokens, known_output_tokens,
    unknown_input_token_requests, unknown_output_token_requests, unknown_token_requests, cny_micro, unpriced_requests
  FROM model_usage_daily)`
export const modelUsageTokenTotalsSql = `COALESCE(SUM(knownTokens), 0) AS knownTokens,
  COALESCE(SUM(knownInputTokens), 0) AS knownInputTokens, COALESCE(SUM(knownOutputTokens), 0) AS knownOutputTokens,
  COALESCE(SUM(unknownInputTokenRequests), 0) AS unknownInputTokenRequests,
  COALESCE(SUM(unknownOutputTokenRequests), 0) AS unknownOutputTokenRequests`
export const modelUsageTotalsSql = `COALESCE(SUM(requests), 0) AS requests,
  COALESCE(SUM(inFlight), 0) AS inFlight, COALESCE(SUM(unknownRequests), 0) AS unknownRequests,
  ${modelUsageTokenTotalsSql}, COALESCE(SUM(unknownTokenRequests), 0) AS unknownTokenRequests,
  SUM(cnyMicro) AS cnyMicro, COALESCE(SUM(unpricedRequests), 0) AS unpricedRequests`
