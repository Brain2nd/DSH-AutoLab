/**
 * Transport primitives shared by the local provider and deterministic tests.
 *
 * This subpath intentionally has no Cordis or DSH runtime dependency.  It is
 * not a second messaging service: DSH integrations consume the abstract seam
 * from the package root and load the concrete provider from `./local`.
 */
export * from './domain.js'
export * from './control.js'
export * from './database.js'
export * from './notifier.js'
