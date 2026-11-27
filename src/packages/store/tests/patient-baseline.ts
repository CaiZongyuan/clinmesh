import billingBaseline from './fixtures/e3842543-v3.json';

export const patientBaseline = { ...billingBaseline, format: 'clinmesh.snapshot.v4',
  tables: [...billingBaseline.tables, { name: 'patient_reply_runs', rows: [] }, { name: 'agent_model_calls', rows: [] }],
  sha256: '49231fd7dc361a0c3cf66fcf41529db849779dbfc3c0fb7e43107b10eb74fe55' };
