/**
 * Backward-compatible re-export shim.
 *
 * All callers import from '../db/queries.js'.
 * The actual implementations now live in the domain files under ./queries/.
 * This file just re-exports everything so existing imports keep working
 * without modification.
 */
export * from './queries/index.js';
