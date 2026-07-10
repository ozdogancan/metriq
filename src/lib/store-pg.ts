// Metriq — Postgres-KV köprüsü: Supabase projesi hazır olana dek kalıcı depolama.
// Kullanıcının mevcut Supabase Postgres'inde izole `metriq` şeması kullanır.
// Kendi projesi açılınca SUPABASE_URL/SERVICE_ROLE_KEY set edilir ve bu sürücü devre dışı kalır.
import 'server-only';
import { Pool } from 'pg';

const URL = process.env.DATABASE_URL;
export const isPg = Boolean(URL) && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

function pg(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: URL,
      max: 3, // Fluid instance başına küçük havuz — pooler limitlerini zorlama
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

// Şema/tablolar cold-start'ta bir kez garanti edilir; transaction-pooler ile
// uyum için tüm sorgular şema-nitelikli (search_path'e güvenme).
function ensure(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pg().query('create schema if not exists metriq');
      await pg().query(
        'create table if not exists metriq.kv (name text primary key, data jsonb not null, updated_at timestamptz not null default now())');
      await pg().query(
        'create table if not exists metriq.files (key text primary key, data bytea not null, created_at timestamptz not null default now())');
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

export async function kvGet<T>(name: string): Promise<T | null> {
  await ensure();
  const { rows } = await pg().query('select data from metriq.kv where name = $1', [name]);
  return rows.length ? (rows[0].data as T) : null;
}

export async function kvSet(name: string, data: unknown): Promise<void> {
  await ensure();
  await pg().query(
    'insert into metriq.kv (name, data, updated_at) values ($1, $2::jsonb, now()) on conflict (name) do update set data = excluded.data, updated_at = now()',
    [name, JSON.stringify(data)]);
}

export async function kvDel(name: string): Promise<void> {
  await ensure();
  await pg().query('delete from metriq.kv where name = $1', [name]);
}

export async function kvList<T>(prefix: string): Promise<T[]> {
  await ensure();
  const { rows } = await pg().query('select data from metriq.kv where name like $1', [prefix.replace(/[%_]/g, '\\$&') + '%']);
  return rows.map(r => r.data as T);
}

export async function pgPutFile(key: string, buf: Buffer): Promise<void> {
  await ensure();
  await pg().query(
    'insert into metriq.files (key, data) values ($1, $2) on conflict (key) do update set data = excluded.data',
    [key, buf]);
}

export async function pgGetFile(key: string): Promise<Buffer> {
  await ensure();
  const { rows } = await pg().query('select data from metriq.files where key = $1', [key]);
  if (!rows.length) throw new Error('file not found');
  return rows[0].data as Buffer;
}

export async function pgDelFiles(prefix: string): Promise<void> {
  await ensure();
  await pg().query('delete from metriq.files where key like $1', [prefix.replace(/[%_]/g, '\\$&') + '%']);
}
