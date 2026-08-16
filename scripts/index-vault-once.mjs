#!/usr/bin/env node
// One-shot: run indexVault against the live DB to backfill obsidian_notes.
import Database from 'better-sqlite3';
import { indexVault } from '../dist/services/obsidian/vault-indexer.js';

const dbPath = process.env.WI_DB || `${process.env.HOME}/.work-intelligence-mcp/data.db`;
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;

if (!vaultPath) {
  console.error('OBSIDIAN_VAULT_PATH not set');
  process.exit(1);
}

const db = new Database(dbPath);
console.log(`indexing vault ${vaultPath} into ${dbPath}...`);
const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM obsidian_notes').get().n;
indexVault(db, vaultPath);
const afterCount = db.prepare('SELECT COUNT(*) AS n FROM obsidian_notes').get().n;
console.log(`obsidian_notes: ${beforeCount} → ${afterCount}`);
db.close();
