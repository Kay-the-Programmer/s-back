/**
 * Bring supplier bills raised the OLD way in line with goods actually received.
 *
 * Before 2026-11-16 a supplier bill was raised for the full purchase order the
 * moment it was placed, and never reduced if the delivery was short or the
 * order was cancelled. Live code now keeps each bill equal to what arrived
 * (accountingService.syncSupplierBillForPO); this applies that rule once to
 * every existing order, posting dated adjustment journals for the differences.
 *
 * Dry run by default — prints what would change and touches nothing:
 *   npm run reconcile:po-bills
 * Apply (one transaction per order, so a failure leaves the others done):
 *   npm run reconcile:po-bills -- --apply
 * Limit to one store:
 *   npm run reconcile:po-bills -- --store=<storeId> [--apply]
 */
import db from '../db_client';
import { accountingService } from '../services/accounting.service';

const apply = process.argv.includes('--apply');
const storeArg = process.argv.find(a => a.startsWith('--store='))?.split('=')[1];

const main = async () => {
    const pool = (db as any)._pool;
    const { rows: orders } = await pool.query(
        `SELECT id, store_id, po_number, status FROM purchase_orders
          WHERE status <> 'draft' ${storeArg ? 'AND store_id = $1' : ''}
          ORDER BY store_id, created_at`,
        storeArg ? [storeArg] : [],
    );

    console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${orders.length} non-draft purchase order(s)${storeArg ? ` in ${storeArg}` : ''}\n`);
    let changed = 0;
    let owedBefore = 0;
    let owedAfter = 0;

    for (const o of orders) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const r = await accountingService.syncSupplierBillForPO(o.id, o.store_id, client, { dryRun: !apply });
            await client.query(apply ? 'COMMIT' : 'ROLLBACK');
            owedBefore += r.before;
            owedAfter += r.after;
            if (r.action !== 'none' && r.action !== 'skipped') {
                changed++;
                console.log(`${r.action.padEnd(8)} ${o.po_number.padEnd(12)} ${o.status.padEnd(19)} bill ${r.before.toFixed(2)} -> ${r.after.toFixed(2)}`);
            }
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`FAILED   ${o.po_number}:`, (err as Error).message);
        } finally {
            client.release();
        }
    }

    console.log(`\n${changed} bill(s) ${apply ? 'adjusted' : 'would change'}. Owed to suppliers on these orders: ${owedBefore.toFixed(2)} -> ${owedAfter.toFixed(2)}`);

    // Lines received more than once by the old double-receive bug. Bills are
    // capped at the ordered amount, but the extra was ALSO added to stock, so
    // those products need a stock count; this script does not touch stock.
    const { rows: over } = await pool.query(
        `SELECT po.store_id, po.po_number, i.product_name, i.quantity, i.received_quantity
           FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
          WHERE i.received_quantity > i.quantity ${storeArg ? 'AND po.store_id = $1' : ''}
          ORDER BY po.store_id, po.po_number`,
        storeArg ? [storeArg] : [],
    );
    if (over.length > 0) {
        console.log(`\n${over.length} line(s) show more received than ordered — likely booked twice. Recount these products:`);
        for (const r of over) {
            console.log(`  ${r.po_number.padEnd(12)} ${String(r.product_name).padEnd(28)} ordered ${Number(r.quantity)}, received ${Number(r.received_quantity)}  (store ${r.store_id})`);
        }
    }
    if (!apply && changed > 0) console.log('Nothing was changed. Re-run with --apply to post the adjustments.');
    await pool.end();
};

main().catch(err => { console.error(err); process.exit(1); });
