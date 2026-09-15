/**
 * Local, disposable state for one hub.
 *
 * Everything that defines the network - who the machines are, which devices
 * are allowed in, what has been revoked - now lives in the shared roster
 * (`@helm/protocol/network`), because every machine needs a full copy of it.
 * What is left here is genuinely local: the login window this hub is offering
 * right now, invites it has issued, a cache of what it last saw each machine
 * reporting, and the digest stream.
 *
 * Deleting this file costs you nothing but history. That is the point: the
 * network survives in the roster, not here.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE = process.env.HELM_DB || './helm.sqlite';
mkdirSync(dirname(FILE), { recursive: true });

export const db = new DatabaseSync(FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  -- The login password is a bootstrap credential and nothing more: valid for
  -- a few minutes, exchanged once for a durable device token. Rotating it
  -- opens a new window; it does NOT sign anyone out, because the devices you
  -- already trust have no further use for it.
  CREATE TABLE IF NOT EXISTS auth_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    password   TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    rotated_at INTEGER NOT NULL
  );

  -- Invites let a new machine join the network. Claiming one hands over the
  -- network key, so they are single-use and short-lived.
  -- role is what the person adding the machine said it was: 'pc' for one that
  -- dials out, 'vm' for one that also becomes a home with its own address.
  -- Carrying it on the invite is what lets "helm join" be the only command
  -- typed on the far machine, whichever kind it is.
  CREATE TABLE IF NOT EXISTS invites (
    code       TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_by    TEXT,
    role       TEXT NOT NULL DEFAULT 'pc'
  );

  -- What each machine last told us about itself. A cache, so the UI can show
  -- a machine that is currently offline; never gossiped, never authoritative.
  CREATE TABLE IF NOT EXISTS machine_state (
    id        TEXT PRIMARY KEY,
    info      TEXT NOT NULL DEFAULT '{}',
    last_seen INTEGER
  );

  CREATE TABLE IF NOT EXISTS digests (
    id         TEXT PRIMARY KEY,
    env_id     TEXT NOT NULL,
    session_id TEXT NOT NULL,
    cwd        TEXT,
    engine     TEXT,
    summary    TEXT,
    state      TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS digests_env_time ON digests(env_id, created_at DESC);
`);

// `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a hub that
// predates a column needs to be told about it directly.
for (const [table, column, spec] of [
  ['invites', 'role', "TEXT NOT NULL DEFAULT 'pc'"],
]) {
  const has = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
}

export const now = () => Date.now();
export const newId = (n = 8) => randomBytes(n).toString('hex');

/** Human-typable invite code: no ambiguous characters. */
export function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) =>
    Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
  return `${pick(4)}-${pick(4)}`;
}

export const q = {
  authGet: db.prepare('SELECT * FROM auth_state WHERE id = 1'),
  authSet: db.prepare(
    `INSERT INTO auth_state (id, password, expires_at, rotated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       password = excluded.password,
       expires_at = excluded.expires_at,
       rotated_at = excluded.rotated_at`
  ),

  inviteInsert: db.prepare('INSERT INTO invites (code, expires_at, role) VALUES (?, ?, ?)'),
  inviteGet: db.prepare('SELECT * FROM invites WHERE code = ?'),
  inviteUse: db.prepare('UPDATE invites SET used_by = ? WHERE code = ?'),
  inviteSweep: db.prepare('DELETE FROM invites WHERE expires_at < ?'),

  stateSet: db.prepare(
    `INSERT INTO machine_state (id, info, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET info = excluded.info, last_seen = excluded.last_seen`
  ),
  stateGet: db.prepare('SELECT * FROM machine_state WHERE id = ?'),
  stateAll: db.prepare('SELECT * FROM machine_state'),

  digestInsert: db.prepare(
    `INSERT INTO digests (id, env_id, session_id, cwd, engine, summary, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  digestRecent: db.prepare('SELECT * FROM digests ORDER BY created_at DESC LIMIT ?'),
  digestByEnv: db.prepare(
    'SELECT * FROM digests WHERE env_id = ? ORDER BY created_at DESC LIMIT ?'
  ),
};
