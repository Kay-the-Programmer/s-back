/**
 * How long a deleted store's archive is kept.
 *
 * Each file here is a whole business — customers, phone numbers, what everybody
 * bought. Nothing about a sweep that silently stops working looks wrong from
 * outside: the directory simply keeps growing, holding other people's records
 * for a reason that expired long ago. So the ageing is tested directly.
 *
 * Usage:
 *   npm run build && node tests/archive-retention.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const ARCHIVES = 'archives';

let passed = 0;
const test = async (name, fn) => {
    try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (err) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err.message}`);
        process.exitCode = 1;
    }
};

/** A file that looks like an archive, aged by the given number of days. */
const seedArchive = (name, ageDays) => {
    mkdirSync(ARCHIVES, { recursive: true });
    const file = join(ARCHIVES, name);
    writeFileSync(file, 'not really gzip, but the sweep only reads the name and the age');
    const when = new Date(Date.now() - ageDays * 86400000);
    utimesSync(file, when, when);
    return file;
};

const load = async () => {
    // Fresh module each time so the retention env var is re-read.
    const mod = await import(`../dist/services/store-deletion.service.js?t=${Date.now()}`);
    return mod;
};

const cleanup = () => {
    try { rmSync(ARCHIVES, { recursive: true, force: true }); } catch { /* nothing to clear */ }
};

const main = async () => {
    cleanup();

    await test('keeps an archive that is still inside the window', async () => {
        process.env.STORE_ARCHIVE_RETENTION_DAYS = '90';
        const fresh = seedArchive('store-fresh-2026.json.gz', 10);
        const { pruneArchives } = await load();
        await pruneArchives();
        assert.equal(existsSync(fresh), true);
    });

    await test('deletes one that has outlived it', async () => {
        process.env.STORE_ARCHIVE_RETENTION_DAYS = '90';
        const old = seedArchive('store-old-2025.json.gz', 100);
        const { pruneArchives } = await load();
        const { deleted } = await pruneArchives();
        assert.equal(existsSync(old), false);
        assert.ok(deleted.includes('store-old-2025.json.gz'), deleted.join(', '));
    });

    await test('the boundary day is treated as expired, not kept', async () => {
        // A window of ninety days should not quietly mean ninety-one.
        process.env.STORE_ARCHIVE_RETENTION_DAYS = '90';
        const edge = seedArchive('store-edge.json.gz', 90);
        const { pruneArchives } = await load();
        await pruneArchives();
        assert.equal(existsSync(edge), false);
    });

    await test('zero means keep forever, rather than delete everything', async () => {
        // The dangerous misreading. Zero has to be "no expiry", because an
        // operator setting it to zero means "stop deleting my archives".
        process.env.STORE_ARCHIVE_RETENTION_DAYS = '0';
        const ancient = seedArchive('store-ancient.json.gz', 5000);
        const { pruneArchives } = await load();
        const { deleted } = await pruneArchives();
        assert.equal(existsSync(ancient), true);
        assert.deepEqual(deleted, []);
    });

    await test('nonsense in the setting falls back to the default, not to zero days', async () => {
        process.env.STORE_ARCHIVE_RETENTION_DAYS = 'whenever';
        const { archiveRetentionDays } = await load();
        assert.equal(archiveRetentionDays(), 90);
    });

    await test('a missing archives directory is not an error', async () => {
        cleanup();
        process.env.STORE_ARCHIVE_RETENTION_DAYS = '90';
        const { pruneArchives, listArchives } = await load();
        assert.deepEqual(await listArchives(), []);
        const { deleted } = await pruneArchives();
        assert.deepEqual(deleted, []);
    });

    await test('refuses a name that climbs out of the archive directory', async () => {
        const { deleteArchive } = await load();
        assert.equal(await deleteArchive('../package.json'), false);
        assert.equal(await deleteArchive('/etc/passwd'), false);
        assert.equal(existsSync('package.json'), true);
    });

    cleanup();
    console.log(`\n${passed} checks passed\n`);
};

main().then(() => process.exit(process.exitCode || 0));
