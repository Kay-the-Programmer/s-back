import db from '../db_client';
import path from 'path';
import { promises as fs } from 'fs';
import { gzip as gzipCb } from 'zlib';
import { promisify } from 'util';

const gzip = promisify(gzipCb);

/**
 * Erasing a store and everything belonging to it.
 *
 * The tables are discovered rather than listed. Forty-nine of them carry a
 * `store_id` today and the schema grows steadily — three were added in a single
 * afternoon recently — so a hand-written list would drift, and the way it fails
 * is the worst possible one for this operation: silence. The store disappears,
 * some table nobody remembered keeps its rows, and the customer who asked to be
 * forgotten is still in the database.
 *
 * Deletion order is derived from the foreign keys rather than guessed, so
 * children go before parents whatever anyone adds later.
 */

/** Tables are named from the catalogue, but quoted and checked all the same. */
const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;

export interface TableCount {
    table: string;
    rows: number;
}

export interface AffectedUser {
    id: string;
    name: string;
    email: string;
}

export interface StoreDeletionPlan {
    storeId: string;
    storeName: string;
    tables: TableCount[];
    totalRows: number;
    /**
     * Accounts left without a store. They keep their login and land on the
     * store-registration flow.
     *
     * Not deleted, deliberately. A person is not the store's data: eleven
     * tables reference a user, several of them holding records that belong to
     * somebody else — another store's audit trail, a marketplace request, an
     * offer someone sent them. Removing an account to tidy up a store would
     * reach into all of it, irreversibly. Deleting people is a separate,
     * deliberate act, not a side effect of deleting a shop.
     */
    usersOrphaned: AffectedUser[];
    /** Accounts that own another store and are moved to it instead. */
    usersRepointed: AffectedUser[];
    /** Uploaded files referenced by the store's own rows. */
    fileUrls: string[];
}

/** Every table with a store_id column, straight from the catalogue. */
const storeScopedTables = async (): Promise<string[]> => {
    const { rows } = await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE column_name = 'store_id' AND table_schema = 'public'
          ORDER BY table_name`,
    );
    return rows.map((r: any) => String(r.table_name)).filter(t => SAFE_TABLE.test(t));
};

/** child → parents, for the tables being deleted. */
const foreignKeyEdges = async (tables: string[]): Promise<Map<string, Set<string>>> => {
    const { rows } = await db.query(
        `SELECT tc.table_name AS child, ccu.table_name AS parent
           FROM information_schema.table_constraints tc
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'`,
    );
    const inScope = new Set(tables);
    const edges = new Map<string, Set<string>>();
    for (const t of tables) edges.set(t, new Set());
    for (const r of rows) {
        const child = String(r.child);
        const parent = String(r.parent);
        // Self-references (a row pointing at another row of its own table) say
        // nothing about table ordering and would make the graph look cyclic.
        if (child === parent) continue;
        if (inScope.has(child) && inScope.has(parent)) edges.get(child)!.add(parent);
    }
    return edges;
};

/**
 * Children first, parents last.
 *
 * A table left in a cycle is emitted anyway rather than dropped: the delete may
 * then fail loudly inside the transaction, which is far better than quietly
 * skipping a table and reporting success.
 */
export const deletionOrder = (tables: string[], edges: Map<string, Set<string>>): string[] => {
    const order: string[] = [];
    const placed = new Set<string>();
    let progress = true;
    while (progress && placed.size < tables.length) {
        progress = false;
        for (const table of tables) {
            if (placed.has(table)) continue;
            // Safe to delete once nothing still-unplaced points at it.
            const blockedBy = [...(edges.get(table) ?? [])].some(p => !placed.has(p) && p !== table);
            if (blockedBy) continue;
            order.push(table);
            placed.add(table);
            progress = true;
        }
    }
    for (const table of tables) if (!placed.has(table)) order.push(table);
    // Children reference parents, so the pass above placed parents first —
    // deleting needs the opposite.
    return order.reverse();
};

/**
 * What deleting this store would destroy, without destroying anything.
 *
 * The point is that a superadmin sees the consequence before agreeing to it —
 * particularly the accounts, which are the part nobody expects. Somebody
 * removing a defunct branch does not necessarily realise its staff logins go
 * with it.
 */
export const planStoreDeletion = async (storeId: string): Promise<StoreDeletionPlan | null> => {
    const store = await db.query('SELECT id, name FROM stores WHERE id = $1', [storeId]);
    if (!store.rowCount) return null;

    const tables = await storeScopedTables();
    const counts: TableCount[] = [];
    let totalRows = 0;
    for (const table of tables) {
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS n FROM "${table}" WHERE store_id = $1`,
            [storeId],
        );
        const n = Number(rows[0]?.n) || 0;
        if (n > 0) {
            counts.push({ table, rows: n });
            totalRows += n;
        }
    }

    const { usersOrphaned, usersRepointed } = await planUsers(storeId);

    return {
        storeId,
        storeName: String(store.rows[0].name),
        tables: counts.sort((a, b) => b.rows - a.rows),
        totalRows,
        usersOrphaned,
        usersRepointed,
        fileUrls: await storeFileUrls(storeId),
    };
};

/**
 * Who moves and who is left without a store.
 *
 * A user who owns another store is pointed at it. One whose only store this
 * was keeps their login and simply has no store — the app already has a place
 * for that, and it is recoverable, which deleting them would not be.
 *
 * A superadmin is never touched: the platform's own operators do not belong to
 * any one store.
 */
const planUsers = async (
    storeId: string,
): Promise<{ usersOrphaned: AffectedUser[]; usersRepointed: AffectedUser[] }> => {
    const { rows } = await db.query(
        `SELECT u.id, u.name, u.email,
                (SELECT COUNT(*)::int FROM stores s
                  WHERE s.owner_id = u.id AND s.id <> $1) AS other_stores
           FROM users u
          WHERE u.current_store_id = $1 AND u.role <> 'superadmin'`,
        [storeId],
    );
    const usersOrphaned: AffectedUser[] = [];
    const usersRepointed: AffectedUser[] = [];
    for (const r of rows) {
        const user = { id: String(r.id), name: String(r.name), email: String(r.email) };
        if (Number(r.other_stores) > 0) usersRepointed.push(user);
        else usersOrphaned.push(user);
    }
    return { usersOrphaned, usersRepointed };
};

/** Uploaded files this store's own rows point at. */
const storeFileUrls = async (storeId: string): Promise<string[]> => {
    const urls = new Set<string>();
    const add = (v: unknown) => {
        if (typeof v === 'string' && v.startsWith('/uploads/')) urls.add(v);
    };
    try {
        const products = await db.query(
            'SELECT image_urls FROM products WHERE store_id = $1', [storeId],
        );
        for (const r of products.rows) {
            const list = Array.isArray(r.image_urls) ? r.image_urls : [];
            for (const u of list) add(u);
        }
        const settings = await db.query(
            'SELECT logo_url FROM store_settings WHERE store_id = $1', [storeId],
        );
        for (const r of settings.rows) add(r.logo_url);
    } catch {
        // Best effort. A file that cannot be listed is a file left on disk,
        // which is untidy — not a reason to refuse to delete the store.
    }
    return [...urls];
};

export interface StoreDeletionResult {
    storeName: string;
    tables: TableCount[];
    totalRows: number;
    usersOrphaned: number;
    usersRepointed: number;
    filesDeleted: number;
    filesFailed: number;
    /** Where the data was written before it was destroyed, if it was. */
    archivePath: string | null;
    archiveBytes: number;
}

/**
 * Erase the store.
 *
 * Every row goes in one transaction, so a failure part-way leaves the store
 * whole rather than half-gutted — a store missing its sales but keeping its
 * products would be worse than either outcome.
 *
 * Files are deleted afterwards, deliberately outside it. They cannot be rolled
 * back, so attempting them first would risk destroying images belonging to a
 * store that then survives. Doing them last means the worst case is an orphaned
 * file on disk, which the result reports rather than hides.
 */
export const executeStoreDeletion = async (
    storeId: string,
    deleteFile: (url: string) => Promise<void>,
    options: { archive?: boolean } = {},
): Promise<StoreDeletionResult | null> => {
    const plan = await planStoreDeletion(storeId);
    if (!plan) return null;

    // Fails closed on purpose. If the archive was asked for and could not be
    // written, the store is not deleted — an operator who ticked the box is
    // relying on it, and quietly proceeding without one would take away the
    // safety net at the exact moment they thought they had it.
    let archive: StoreArchive | null = null;
    if (options.archive !== false) {
        archive = await archiveStore(storeId);
    }

    const tables = await storeScopedTables();
    const order = deletionOrder(tables, await foreignKeyEdges(tables));

    const client = await (db as any)._pool.connect();
    const deleted: TableCount[] = [];
    let totalRows = 0;
    try {
        await client.query('BEGIN');

        // Accounts move before the store goes, so no user is ever left
        // pointing at a store that no longer exists.
        for (const user of plan.usersRepointed) {
            await client.query(
                `UPDATE users SET current_store_id =
                    (SELECT id FROM stores WHERE owner_id = $1 AND id <> $2 ORDER BY id LIMIT 1)
                  WHERE id = $1`,
                [user.id, storeId],
            );
        }
        // The rest keep their login with no store attached. Clearing the
        // pointer is what puts them on the app's store-registration flow rather
        // than into an error.
        if (plan.usersOrphaned.length) {
            await client.query(
                'UPDATE users SET current_store_id = NULL WHERE id = ANY($1::text[])',
                [plan.usersOrphaned.map(u => u.id)],
            );
        }

        for (const table of order) {
            const { rowCount } = await client.query(
                `DELETE FROM "${table}" WHERE store_id = $1`, [storeId],
            );
            if (rowCount) {
                deleted.push({ table, rows: rowCount });
                totalRows += rowCount;
            }
        }

        const store = await client.query('DELETE FROM stores WHERE id = $1 RETURNING name', [storeId]);
        if (!store.rowCount) throw new Error('Store vanished mid-deletion.');

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }

    let filesDeleted = 0;
    let filesFailed = 0;
    for (const url of plan.fileUrls) {
        try {
            await deleteFile(url);
            filesDeleted++;
        } catch {
            filesFailed++;
        }
    }

    return {
        storeName: plan.storeName,
        tables: deleted.sort((a, b) => b.rows - a.rows),
        totalRows,
        usersOrphaned: plan.usersOrphaned.length,
        usersRepointed: plan.usersRepointed.length,
        filesDeleted,
        filesFailed,
        archivePath: archive?.path ?? null,
        archiveBytes: archive?.bytes ?? 0,
    };
};

/**
 * Where store archives are written.
 *
 * Deliberately not under `uploads/`, which is served statically at /uploads —
 * an archive there would publish a shop's entire customer list at a guessable
 * URL. This directory is never served.
 */
const ARCHIVE_ROOT = path.join(__dirname, '../../archives');

export interface StoreArchive {
    path: string;
    bytes: number;
}

/**
 * Write everything belonging to a store to a file, before deleting it.
 *
 * Not a substitute for the nightly database backup — it is the thing that makes
 * one particular irreversible click survivable, on the day it is made rather
 * than at 2am the night before.
 *
 * There is a real tension here and the caller is given the choice because of
 * it: an archive is exactly what you want when the deletion was a mistake, and
 * exactly what you must not keep when the deletion was somebody exercising a
 * right to be forgotten.
 */
export const archiveStore = async (storeId: string): Promise<StoreArchive> => {
    const tables = await storeScopedTables();
    const dump: Record<string, unknown> = {
        archivedAt: new Date().toISOString(),
        storeId,
    };

    const store = await db.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    dump.stores = store.rows;

    for (const table of tables) {
        const { rows } = await db.query(`SELECT * FROM "${table}" WHERE store_id = $1`, [storeId]);
        if (rows.length) dump[table] = rows;
    }

    await fs.mkdir(ARCHIVE_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeId = storeId.replace(/[^A-Za-z0-9_-]/g, '_');
    const file = path.join(ARCHIVE_ROOT, `store-${safeId}-${stamp}.json.gz`);

    const body = await gzip(Buffer.from(JSON.stringify(dump), 'utf8'));
    await fs.writeFile(file, body);
    return { path: file, bytes: body.length };
};

/**
 * How long a store archive is kept, in days. Zero keeps them forever.
 *
 * Ninety days by default: long enough that a deletion nobody noticed at the
 * time can still be undone, short enough that the shop is not holding other
 * people's customer records indefinitely for no stated reason. A file here is
 * a complete business — names, phone numbers, what everybody bought — so
 * keeping it needs a reason with an end date, not merely no reason to delete.
 */
export const archiveRetentionDays = (): number => {
    const raw = Number(process.env.STORE_ARCHIVE_RETENTION_DAYS);
    if (!Number.isFinite(raw) || raw < 0) return 90;
    return Math.floor(raw);
};

export interface ArchiveFile {
    name: string;
    bytes: number;
    createdAt: Date;
    ageDays: number;
}

/** Archives currently held, newest first. */
export const listArchives = async (): Promise<ArchiveFile[]> => {
    let names: string[];
    try {
        names = await fs.readdir(ARCHIVE_ROOT);
    } catch {
        // No directory means nothing has ever been archived, which is not a
        // problem to report — it is the state every fresh install is in.
        return [];
    }
    const now = Date.now();
    const files: ArchiveFile[] = [];
    for (const name of names) {
        if (!name.endsWith('.json.gz')) continue;
        try {
            const stat = await fs.stat(path.join(ARCHIVE_ROOT, name));
            files.push({
                name,
                bytes: stat.size,
                createdAt: stat.mtime,
                ageDays: Math.floor((now - stat.mtime.getTime()) / 86400000),
            });
        } catch {
            // Vanished between listing and stat. Nothing to report.
        }
    }
    return files.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
};

/**
 * Delete archives past their retention.
 *
 * Runs on a timer rather than waiting for someone to remember, because the
 * failure mode of forgetting is not an error anyone sees — it is a directory
 * quietly accumulating every customer of every store ever deleted.
 */
export const pruneArchives = async (): Promise<{ deleted: string[]; keptDays: number }> => {
    const keptDays = archiveRetentionDays();
    if (keptDays === 0) return { deleted: [], keptDays };

    const deleted: string[] = [];
    for (const file of await listArchives()) {
        if (file.ageDays < keptDays) continue;
        try {
            await fs.unlink(path.join(ARCHIVE_ROOT, file.name));
            deleted.push(file.name);
        } catch {
            // Left for the next run rather than failing the sweep: one
            // undeletable file must not stop the rest being cleared.
        }
    }
    return { deleted, keptDays };
};

/** Remove one archive by name, for a request that arrives after the fact. */
export const deleteArchive = async (name: string): Promise<boolean> => {
    // Name only — anything with a path separator is refused, so a crafted name
    // cannot reach out of the archive directory.
    if (!/^[A-Za-z0-9._-]+\.json\.gz$/.test(name)) return false;
    try {
        await fs.unlink(path.join(ARCHIVE_ROOT, name));
        return true;
    } catch {
        return false;
    }
};
