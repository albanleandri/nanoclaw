// Narrow bridge keeps task lifecycle code testable without importing delivery internals.
export { wakeContainer } from '../container-runner.js';
export { clearOutbox, sessionDir, writeSessionMessageIfAbsent } from '../session-manager.js';
