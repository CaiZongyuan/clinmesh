export { ModuleRegistry, gateItem, parseRuntimeHealth, workbenchTab, type ClinMeshModule, type CompletionCheck, type RuntimeHealth } from './lib/module-registry';
export { CoreError, createVisitorGate, sha256, type Credential, type GateSettings, type Ticket } from './lib/visitor-gate';
export { authorize, checkVersion, commandEnvelope, executeCommand, localizedName, permits, practitionerRole, resolveActor, type Access, type Actor, type CommandContext, type CommandEnvelope, type Route } from './lib/commands';
export { OperationCatalog, type ReadContext } from './lib/operation-catalog';
export { administer, registerPlatformOperations, sessionSchema, sessionView } from './lib/control-plane';
