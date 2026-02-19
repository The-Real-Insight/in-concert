/**
 * Local-mode helpers for worklist projection.
 * Use when running the engine in-process (no REST server).
 *
 * import { addStreamHandler, createProjectionHandler } from 'tri-bpmn-engine/local';
 * addStreamHandler(createProjectionHandler(db));
 */
export { addStreamHandler } from './ws/broadcast';
export { createProjectionHandler } from './worklist/projection';
