/**
 * Open bills (tabs) — restaurants, bars and cafes.
 * --------------------------------------------------------------------------
 * A venue cannot ring a sale up and finish it in one pass: a table orders
 * drinks, then starters, then more drinks, and pays at the end. The till's
 * existing held sales can't do that job, because they live in one browser's
 * localStorage — the waiter who started Table 4 would be the only person able
 * to add to it.
 *
 * So an open bill is a parked cart that lives on the server. Deliberately, this
 * file contains NO money, tax, stock or accounting logic: settling a bill goes
 * through the ordinary POST /sales path, which is the one authority on totals,
 * tax classes, stock, COGS, journal entries, till stamping and loyalty. The
 * totals returned below are a display convenience for the bills list; what the
 * customer pays is computed by the sale, server-side, as always.
 *
 * The status field is the whole concurrency story:
 *
 *   open     — being added to
 *   settling — a till has CLAIMED it and is posting the sale
 *   closed   — paid, with sale_id pointing at the sale
 *   void     — thrown away (a walkout, a mis-key), with a reason
 *
 * Every transition is a conditional UPDATE guarded on the status it expects, so
 * two tills that both tap Pay on Table 4 cannot both charge it: the second gets
 * a 409 instead of a duplicate sale.
 */
import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';

const storeOf = (req: express.Request): string | undefined =>
    (req as any).tenant?.storeId || req.user?.currentStoreId;

const noStore = (res: express.Response) =>
    res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });

/** A bill label is shown on a ticket and typed in a hurry — keep it short and clean. */
const cleanLabel = (raw: unknown): string =>
    String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

const LIVE = ['open', 'settling'];

/**
 * Load one bill with its lines, scoped to the store.
 *
 * Returns null rather than throwing so each caller decides what a miss means
 * (404 on a read, 409 on a transition).
 */
const loadTab = async (client: any, storeId: string, tabId: string) => {
    const tab = await client.query('SELECT * FROM open_tabs WHERE id = $1 AND store_id = $2', [tabId, storeId]);
    if (tab.rowCount === 0) return null;
    const items = await client.query(
        'SELECT * FROM open_tab_items WHERE tab_id = $1 AND store_id = $2 ORDER BY created_at, id',
        [tabId, storeId],
    );
    return { ...tab.rows[0], items: items.rows };
};

/**
 * Shape a bill for the client: camelCase, with the running total the bills list
 * shows. This is a SUBTOTAL of frozen line prices — not a quote. Discounts and
 * tax are the sale's business, so the till recomputes the real figure at
 * payment and the server recomputes it again.
 */
const presentTab = (row: any) => {
    const items = (row.items || []).map((i: any) => ({
        ...toCamelCase(i),
        price: Number(i.price) || 0,
        quantity: Number(i.quantity) || 0,
        costPrice: i.cost_price === null || i.cost_price === undefined ? undefined : Number(i.cost_price),
    }));
    const itemCount = items.reduce((n: number, i: any) => n + i.quantity, 0);
    const subtotal = items.reduce((sum: number, i: any) => sum + i.price * i.quantity, 0);
    return {
        ...toCamelCase({ ...row, items: undefined }),
        items,
        itemCount: Math.round(itemCount * 1000) / 1000,
        subtotal: Math.round(subtotal * 100) / 100,
    };
};

/** GET /hospitality/tabs?status=open|all — the bills list. */
export const listTabs = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);

    const wanted = String(req.query.status || 'live');
    try {
        // One query for the headers and one for all their lines, rather than a
        // query per bill: a busy Friday has thirty tables open and the list is
        // polled.
        const statusFilter = wanted === 'all' ? null : (wanted === 'live' ? LIVE : [wanted]);
        const tabsRes = statusFilter
            ? await db.query(
                'SELECT * FROM open_tabs WHERE store_id = $1 AND status = ANY($2::text[]) ORDER BY opened_at',
                [storeId, statusFilter],
            )
            : await db.query('SELECT * FROM open_tabs WHERE store_id = $1 ORDER BY opened_at DESC LIMIT 200', [storeId]);

        const ids = tabsRes.rows.map((t: any) => t.id);
        const itemsRes = ids.length
            ? await db.query(
                'SELECT * FROM open_tab_items WHERE store_id = $1 AND tab_id = ANY($2::text[]) ORDER BY created_at, id',
                [storeId, ids],
            )
            : { rows: [] as any[] };

        const byTab = new Map<string, any[]>();
        for (const item of itemsRes.rows) {
            const list = byTab.get(item.tab_id) || [];
            list.push(item);
            byTab.set(item.tab_id, list);
        }

        res.status(200).json(tabsRes.rows.map((t: any) => presentTab({ ...t, items: byTab.get(t.id) || [] })));
    } catch (error) {
        console.error('Error listing open bills:', error);
        res.status(500).json({ message: 'Error loading open bills' });
    }
};

/** GET /hospitality/tabs/:id */
export const getTab = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);
    try {
        const tab = await loadTab(db, storeId, req.params.id);
        if (!tab) return res.status(404).json({ message: 'That bill no longer exists.' });
        res.status(200).json(presentTab(tab));
    } catch (error) {
        console.error('Error loading open bill:', error);
        res.status(500).json({ message: 'Error loading bill' });
    }
};

/**
 * POST /hospitality/tabs — open a bill, optionally with its first round.
 *
 * Opening and adding in one call matters: a waiter takes the order and the
 * table name together, and two round trips on a weak connection is how you end
 * up with an empty "Table 4" nobody can explain.
 */
export const createTab = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);

    const label = cleanLabel(req.body?.label);
    if (!label) return res.status(400).json({ message: 'Give the bill a name — a table number or the customer’s name.' });

    const client = await (db as any)._pool.connect();
    try {
        await client.query('BEGIN');
        const id = generateId('tab');
        await client.query(
            `INSERT INTO open_tabs (id, store_id, label, status, customer_id, note, opened_by, opened_by_name)
             VALUES ($1, $2, $3, 'open', $4, $5, $6, $7)`,
            [
                id, storeId, label,
                req.body?.customerId || null,
                req.body?.note ? String(req.body.note).slice(0, 500) : null,
                req.user?.id || null,
                req.user?.name || null,
            ],
        );

        const added = await insertItems(client, storeId, id, req.body?.items, req.user?.id);
        await client.query('COMMIT');

        const tab = await loadTab(db, storeId, id);
        auditService.log(req.user!, 'Bill Opened', `Bill "${label}"${added ? ` with ${added} item(s)` : ''}`);
        res.status(201).json(presentTab(tab));
    } catch (error: any) {
        await client.query('ROLLBACK').catch(() => { });
        // The partial unique index on a live label: two waiters both opening
        // "Table 4" would split one table's bill in half.
        if (error?.code === '23505' || error?.code === '23P01') {
            return res.status(409).json({
                message: `A bill called “${label}” is already open. Add to that one instead.`,
                code: 'TAB_LABEL_TAKEN',
            });
        }
        console.error('Error opening bill:', error);
        res.status(500).json({ message: 'Error opening bill' });
    } finally {
        client.release();
    }
};

/**
 * Write lines onto a bill, snapshotting name, price, cost and tax class off the
 * product AT THIS MOMENT.
 *
 * The snapshot is the point. Joining to products at settle time would mean a
 * 7pm menu reprice silently rewrites the bill a table has been drinking against
 * since five o'clock. Cost and tax class are frozen with it so the eventual
 * sale, and its COGS, describe what was actually served.
 *
 * Price is taken from the product, never from the client: a till that could
 * name its own prices is a till that can be told to charge zero.
 */
const insertItems = async (
    client: any,
    storeId: string,
    tabId: string,
    rawItems: unknown,
    userId?: string,
): Promise<number> => {
    if (!Array.isArray(rawItems) || rawItems.length === 0) return 0;

    const wanted = rawItems
        .map((i: any) => ({
            productId: String(i?.productId ?? ''),
            quantity: Number(i?.quantity ?? 1),
            note: i?.note ? String(i.note).slice(0, 200) : null,
        }))
        .filter(i => i.productId && Number.isFinite(i.quantity) && i.quantity > 0);
    if (wanted.length === 0) return 0;

    const products = await client.query(
        `SELECT id, name, sku, price, cost_price, unit_of_measure, tax_class, track_stock
           FROM products WHERE id = ANY($1::text[]) AND store_id = $2`,
        [wanted.map(w => w.productId), storeId],
    );
    const byId = new Map<string, any>(products.rows.map((p: any) => [p.id, p]));

    let added = 0;
    for (const line of wanted) {
        const product = byId.get(line.productId);
        // An item that isn't in this store's catalog is skipped rather than
        // invented: there is no price we could honestly charge for it.
        if (!product) continue;

        // Repeat rounds merge into the existing line, so a table that orders
        // four more Mosis reads "6 × Mosi" and not six separate lines.
        const existing = await client.query(
            `SELECT id, quantity FROM open_tab_items
              WHERE tab_id = $1 AND store_id = $2 AND product_id = $3 AND price = $4
              ORDER BY created_at LIMIT 1`,
            [tabId, storeId, line.productId, product.price],
        );

        if (existing.rowCount > 0) {
            await client.query(
                'UPDATE open_tab_items SET quantity = quantity + $1 WHERE id = $2 AND store_id = $3',
                [line.quantity, existing.rows[0].id, storeId],
            );
        } else {
            await client.query(
                `INSERT INTO open_tab_items
                   (id, tab_id, store_id, product_id, name, sku, price, cost_price, quantity, unit_of_measure, tax_class, track_stock, added_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    generateId('tbi'), tabId, storeId, product.id, product.name, product.sku,
                    product.price, product.cost_price, line.quantity,
                    product.unit_of_measure, product.tax_class, product.track_stock !== false,
                    userId || null,
                ],
            );
        }
        added += 1;
    }

    await client.query('UPDATE open_tabs SET updated_at = NOW() WHERE id = $1 AND store_id = $2', [tabId, storeId]);
    return added;
};

/** POST /hospitality/tabs/:id/items — add a round. */
export const addTabItems = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);

    const client = await (db as any)._pool.connect();
    try {
        await client.query('BEGIN');
        // Locked for the length of the write, so a round added at the same
        // moment as a settle can't slip in after the sale was totalled.
        const guard = await client.query(
            'SELECT status, label FROM open_tabs WHERE id = $1 AND store_id = $2 FOR UPDATE',
            [req.params.id, storeId],
        );
        if (guard.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'That bill no longer exists.' });
        }
        if (guard.rows[0].status !== 'open') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: guard.rows[0].status === 'settling'
                    ? 'Someone is taking payment for this bill right now.'
                    : 'That bill has already been closed.',
                code: 'TAB_NOT_OPEN',
                status: guard.rows[0].status,
            });
        }

        const added = await insertItems(client, storeId, req.params.id, req.body?.items, req.user?.id);
        await client.query('COMMIT');

        if (added === 0) {
            return res.status(400).json({ message: 'Nothing was added — those items aren’t in your menu.' });
        }
        const tab = await loadTab(db, storeId, req.params.id);
        res.status(200).json(presentTab(tab));
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('Error adding to bill:', error);
        res.status(500).json({ message: 'Error adding to bill' });
    } finally {
        client.release();
    }
};

/** PATCH /hospitality/tabs/:id/items/:itemId — change a quantity. */
export const updateTabItem = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);

    const quantity = Number(req.body?.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
        return res.status(400).json({ message: 'Send a quantity of zero or more.' });
    }

    try {
        const guard = await db.query('SELECT status FROM open_tabs WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
        if (guard.rowCount === 0) return res.status(404).json({ message: 'That bill no longer exists.' });
        if (guard.rows[0].status !== 'open') {
            return res.status(409).json({ message: 'That bill is no longer open.', code: 'TAB_NOT_OPEN' });
        }

        // Zero removes the line, which is what tapping "−" down to nothing
        // means to the person holding the tablet.
        if (quantity === 0) {
            await db.query('DELETE FROM open_tab_items WHERE id = $1 AND tab_id = $2 AND store_id = $3',
                [req.params.itemId, req.params.id, storeId]);
        } else {
            const r = await db.query(
                'UPDATE open_tab_items SET quantity = $1 WHERE id = $2 AND tab_id = $3 AND store_id = $4',
                [quantity, req.params.itemId, req.params.id, storeId],
            );
            if ((r.rowCount ?? 0) === 0) return res.status(404).json({ message: 'That line is no longer on the bill.' });
        }
        await db.query('UPDATE open_tabs SET updated_at = NOW() WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);

        const tab = await loadTab(db, storeId, req.params.id);
        res.status(200).json(presentTab(tab));
    } catch (error) {
        console.error('Error updating bill line:', error);
        res.status(500).json({ message: 'Error updating bill' });
    }
};

/** DELETE /hospitality/tabs/:id/items/:itemId */
export const removeTabItem = async (req: express.Request, res: express.Response) => {
    (req.body as any) = { quantity: 0 };
    return updateTabItem(req, res);
};

/**
 * POST /hospitality/tabs/:id/claim — "I am taking payment for this."
 *
 * The claim exists because the sale itself is posted by the client through
 * POST /sales. Without it, two tills could each load Table 4, each post a sale,
 * and the table would be charged twice with both receipts looking correct. The
 * conditional UPDATE means exactly one till wins the race; the other is told
 * who has it.
 */
export const claimTab = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);

    try {
        const r = await db.query(
            `UPDATE open_tabs SET status = 'settling', updated_at = NOW()
              WHERE id = $1 AND store_id = $2 AND status = 'open'
              RETURNING *`,
            [req.params.id, storeId],
        );
        if ((r.rowCount ?? 0) === 0) {
            const cur = await db.query('SELECT status, label FROM open_tabs WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
            if (cur.rowCount === 0) return res.status(404).json({ message: 'That bill no longer exists.' });
            const status = cur.rows[0].status;
            return res.status(409).json({
                message: status === 'settling'
                    ? 'Another till is taking payment for this bill.'
                    : 'That bill has already been settled.',
                code: 'TAB_NOT_OPEN',
                status,
            });
        }
        const tab = await loadTab(db, storeId, req.params.id);
        res.status(200).json(presentTab(tab));
    } catch (error) {
        console.error('Error claiming bill:', error);
        res.status(500).json({ message: 'Error claiming bill' });
    }
};

/**
 * POST /hospitality/tabs/:id/release — give a claimed bill back.
 *
 * Called when the sale failed or the cashier backed out. Without it a dropped
 * connection mid-payment would strand the table in 'settling', where nobody can
 * add to it and nobody can pay it.
 */
export const releaseTab = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);
    try {
        const r = await db.query(
            `UPDATE open_tabs SET status = 'open', updated_at = NOW()
              WHERE id = $1 AND store_id = $2 AND status = 'settling' RETURNING *`,
            [req.params.id, storeId],
        );
        if ((r.rowCount ?? 0) === 0) {
            return res.status(409).json({ message: 'That bill is not being settled.', code: 'TAB_NOT_SETTLING' });
        }
        const tab = await loadTab(db, storeId, req.params.id);
        res.status(200).json(presentTab(tab));
    } catch (error) {
        console.error('Error releasing bill:', error);
        res.status(500).json({ message: 'Error releasing bill' });
    }
};

/**
 * POST /hospitality/tabs/:id/close — the sale went through; put the bill away.
 *
 * `saleId` must name a sale that exists in THIS store. Taking the client's word
 * for it would let a bill be closed against nothing, leaving money taken with
 * no record of which sale took it. A bill that is still 'open' can also be
 * closed directly, so a till that lost its claim response mid-payment can still
 * finish cleanly instead of charging the table twice.
 */
export const closeTab = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);

    const saleId = String(req.body?.saleId || '').trim();
    if (!saleId) return res.status(400).json({ message: 'Which sale settled this bill?' });

    try {
        const sale = await db.query('SELECT transaction_id FROM sales WHERE transaction_id = $1 AND store_id = $2', [saleId, storeId]);
        if (sale.rowCount === 0) {
            return res.status(400).json({ message: 'That sale does not exist in this shop.', code: 'SALE_NOT_FOUND' });
        }

        const r = await db.query(
            `UPDATE open_tabs
                SET status = 'closed', sale_id = $3, closed_at = NOW(), closed_by = $4, updated_at = NOW()
              WHERE id = $1 AND store_id = $2 AND status = ANY($5::text[])
              RETURNING *`,
            [req.params.id, storeId, saleId, req.user?.id || null, LIVE],
        );
        if ((r.rowCount ?? 0) === 0) {
            const cur = await db.query('SELECT status, sale_id FROM open_tabs WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
            if (cur.rowCount === 0) return res.status(404).json({ message: 'That bill no longer exists.' });
            // Already closed against this same sale: the till is retrying a
            // call that actually succeeded, so treat it as done rather than
            // alarming the cashier mid-service.
            if (cur.rows[0].status === 'closed' && cur.rows[0].sale_id === saleId) {
                const tab = await loadTab(db, storeId, req.params.id);
                return res.status(200).json(presentTab(tab));
            }
            return res.status(409).json({
                message: 'That bill was already settled.',
                code: 'TAB_ALREADY_CLOSED',
                status: cur.rows[0].status,
            });
        }

        auditService.log(req.user!, 'Bill Settled', `Bill "${r.rows[0].label}" settled by sale ${saleId}`);
        const tab = await loadTab(db, storeId, req.params.id);
        res.status(200).json(presentTab(tab));
    } catch (error) {
        console.error('Error closing bill:', error);
        res.status(500).json({ message: 'Error closing bill' });
    }
};

/**
 * POST /hospitality/tabs/:id/void — throw a bill away unpaid.
 *
 * A walkout or a mis-keyed order. The row is kept, not deleted, with who did it
 * and why: an unpaid bill with items on it is written-off revenue, and the one
 * thing it must never be is invisible. Stock is untouched because an open bill
 * never moved any.
 */
export const voidTab = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return noStore(res);

    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ message: 'Say why this bill is being written off.' });

    try {
        const r = await db.query(
            `UPDATE open_tabs
                SET status = 'void', void_reason = $3, closed_at = NOW(), closed_by = $4, updated_at = NOW()
              WHERE id = $1 AND store_id = $2 AND status = ANY($5::text[])
              RETURNING *`,
            [req.params.id, storeId, reason, req.user?.id || null, LIVE],
        );
        if ((r.rowCount ?? 0) === 0) {
            return res.status(409).json({ message: 'That bill is not open.', code: 'TAB_NOT_OPEN' });
        }
        const tab = await loadTab(db, storeId, req.params.id);
        auditService.log(
            req.user!,
            'Bill Voided',
            `Bill "${r.rows[0].label}" written off (${presentTab(tab).itemCount} item(s)): ${reason}`,
        );
        res.status(200).json(presentTab(tab));
    } catch (error) {
        console.error('Error voiding bill:', error);
        res.status(500).json({ message: 'Error voiding bill' });
    }
};
