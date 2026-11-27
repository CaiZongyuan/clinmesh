import { v5 } from 'uuid';

export const clinicalFactId = (...parts: string[]) => v5(JSON.stringify(parts), v5.URL);
export const clinicalFactSystem = 'urn:clinmesh:clinical';
export const triageMeasures = { heartRateBpm: ['8867-4', '/min'], systolicMmHg: ['8480-6', 'mm[Hg]'], diastolicMmHg: ['8462-4', 'mm[Hg]'], temperatureC: ['8310-5', 'Cel'], respiratoryRate: ['9279-1', '/min'], spo2Percent: ['2708-6', '%'] } as const;
