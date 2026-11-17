import express from 'express';
import db from '../db_client';
import { Category } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';


export const getCategories = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
        }
        // sort_order first: a menu is read Starters → Desserts, never
        // alphabetically. Retail stores leave it at 0, so they still sort by
        // name exactly as before.
        const result = await db.query(
            'SELECT * FROM categories WHERE store_id = $1 ORDER BY sort_order, name',
            [storeId],
        );
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ message: 'Error fetching categories' });
    }
};

/**
 * A new section is appended, not inserted at the top: a menu grows at the end
 * unless the owner drags it elsewhere. A client that sends an explicit
 * sortOrder wins.
 */
const nextSortOrder = async (storeId: string): Promise<number> => {
    const r = await db.query(
        'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM categories WHERE store_id = $1',
        [storeId],
    );
    return Number(r.rows[0]?.next ?? 10);
};

export const createCategory = async (req: express.Request, res: express.Response) => {
    const { name, parentId, attributes, revenueAccountId, cogsAccountId, sortOrder, isHidden } = req.body;
    const id = generateId('cat');

    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
        }
        const order = Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : await nextSortOrder(storeId);
        const result = await db.query(
            'INSERT INTO categories (id, name, parent_id, attributes, revenue_account_id, cogs_account_id, store_id, sort_order, is_hidden) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
            [id, name, parentId || null, JSON.stringify(attributes || []), revenueAccountId, cogsAccountId, storeId, order, isHidden === true]
        );
        const newCategory = result.rows[0];
        auditService.log(req.user!, 'Category Created', `Category: "${newCategory.name}"`);
        res.status(201).json(toCamelCase(newCategory));
    } catch (error) {
        console.error('Error creating category:', error);
        res.status(500).json({ message: 'Error creating category' });
    }
};

export const updateCategory = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { name, parentId, attributes, revenueAccountId, cogsAccountId, sortOrder, isHidden } = req.body;
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
        }
        // sort_order and is_hidden are COALESCEd: a screen that predates the
        // menu (the Stock app's category editor) must not reset a menu's order
        // to zero just by saving a rename.
        const result = await db.query(
            `UPDATE categories SET name = $1, parent_id = $2, attributes = $3, revenue_account_id = $4, cogs_account_id = $5,
                 sort_order = COALESCE($8, sort_order), is_hidden = COALESCE($9, is_hidden)
             WHERE id = $6 AND store_id = $7 RETURNING *`,
            [
                name, parentId || null, JSON.stringify(attributes || []), revenueAccountId, cogsAccountId, id, storeId,
                Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : null,
                typeof isHidden === 'boolean' ? isHidden : null,
            ]
        );
        if ((result.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'Category not found' });
        }
        const updatedCategory = result.rows[0];
        auditService.log(req.user!, 'Category Updated', `Category: "${updatedCategory.name}"`);
        res.status(200).json(toCamelCase(updatedCategory));
    } catch (error) {
        console.error(`Error updating category ${id}:`, error);
        res.status(500).json({ message: 'Error updating category' });
    }
};

/**
 * Delete a category and, with `?cascade=true`, everything filed underneath it.
 *
 * Deleting a parent used to be refused outright, and it had to be: the schema's
 * own constraints make an unguarded delete either wrong or impossible.
 * `categories.parent_id` is ON DELETE SET NULL, so removing a parent would
 * quietly promote its children to top level rather than remove them, and
 * `products.category_id` has no ON DELETE action at all, so Postgres rejects the
 * row outright the moment a single product still points at it.
 *
 * So the whole subtree is resolved up front and removed in one transaction,
 * deepest first, with the affected products detached to uncategorised. Products
 * are never deleted — a category is how stock is filed, not the stock itself.
 *
 * Without `cascade` the old refusal stands, but as a 409 carrying the counts
 * behind it, so a client can show what is about to go and ask before retrying.
 */
export const deleteCategory = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const cascade = req.query.cascade === 'true' || req.query.cascade === '1';
    const client = await (db as any)._pool.connect();

    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
        }

        await client.query('BEGIN');

        // The subtree, root included. Walking it in SQL keeps a deep tree to one
        // round trip; the store filter is applied at every level so a category
        // cannot drag in another tenant's rows even if a parent_id crossed over.
        const subtree = await client.query(
            `WITH RECURSIVE tree AS (
                 SELECT id, name, 0 AS depth
                 FROM categories
                 WHERE id = $1 AND store_id = $2
                 UNION ALL
                 SELECT c.id, c.name, tree.depth + 1
                 -- Depth is capped so a parent_id cycle (nothing prevents one
                 -- being saved) cannot spin the recursion forever.
                 FROM categories c
                 JOIN tree ON c.parent_id = tree.id
                 WHERE c.store_id = $2 AND tree.depth < 50
             )
             SELECT id, name, depth FROM tree`,
            [id, storeId]
        );

        if (subtree.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Category not found' });
        }

        const rows = subtree.rows as { id: string; name: string; depth: number }[];
        const ids = rows.map(r => r.id);
        const root = rows.find(r => r.depth === 0)!;
        const descendants = rows.length - 1;

        const productCount = await client.query(
            'SELECT COUNT(*)::int AS n FROM products WHERE category_id = ANY($1) AND store_id = $2',
            [ids, storeId]
        );
        const affectedProducts: number = productCount.rows[0]?.n ?? 0;

        if (!cascade && (descendants > 0 || affectedProducts > 0)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: descendants > 0
                    ? `"${root.name}" has ${descendants} sub-categor${descendants === 1 ? 'y' : 'ies'}` +
                      (affectedProducts > 0 ? ` and ${affectedProducts} product${affectedProducts === 1 ? '' : 's'} filed under it.` : '.')
                    : `"${root.name}" has ${affectedProducts} product${affectedProducts === 1 ? '' : 's'} filed under it.`,
                code: 'CATEGORY_NOT_EMPTY',
                subCategories: descendants,
                affectedProducts,
            });
        }

        // Products outlive their category — they are only unfiled. Done before
        // the delete because products.category_id has no ON DELETE action, so
        // the constraint would otherwise reject the row.
        if (affectedProducts > 0) {
            await client.query(
                'UPDATE products SET category_id = NULL WHERE category_id = ANY($1) AND store_id = $2',
                [ids, storeId]
            );
        }

        // Deepest first, so no row is ever removed while a child still points at
        // it — parent_id is ON DELETE SET NULL, and a child left behind for even
        // one statement would be silently promoted to top level instead of going.
        const deepestFirst = [...rows].sort((a, b) => b.depth - a.depth).map(r => r.id);
        for (const categoryId of deepestFirst) {
            await client.query(
                'DELETE FROM categories WHERE id = $1 AND store_id = $2',
                [categoryId, storeId]
            );
        }

        await client.query('COMMIT');

        auditService.log(
            req.user!,
            'Category Deleted',
            `Category: "${root.name}"` +
                (descendants > 0 ? ` and ${descendants} sub-categor${descendants === 1 ? 'y' : 'ies'}` : '') +
                (affectedProducts > 0 ? `; ${affectedProducts} product${affectedProducts === 1 ? '' : 's'} left uncategorised` : '')
        );

        res.status(200).json({
            message: 'Category deleted',
            deleted: rows.length,
            subCategories: descendants,
            affectedProducts,
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { });
        console.error(`Error deleting category ${id}:`, error);
        res.status(500).json({ message: 'Error deleting category' });
    } finally {
        client.release();
    }
};

/**
 * Reorder menu sections in one shot.
 *
 * Dragging a section is one gesture that moves several rows — saving each one
 * through PUT /categories/:id would leave the menu half-reordered if the
 * network dropped mid-drag, and would race with itself. So the whole new order
 * arrives as a list and is written in a single transaction.
 *
 * Positions are rewritten as 10, 20, 30… rather than trusting the client's
 * numbers, so repeated drags can't drift into collisions.
 */
export const reorderCategories = async (req: express.Request, res: express.Response) => {
    const storeId = req.tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
    }

    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(i => typeof i === 'string')) {
        return res.status(400).json({ message: 'Send { ids: [categoryId, ...] } in the order you want them shown.' });
    }

    const client = await (db as any)._pool.connect();
    try {
        await client.query('BEGIN');
        // Scoped by store_id on every row, so a client cannot reposition
        // another tenant's categories by guessing ids.
        let position = 0;
        let updated = 0;
        for (const id of ids as string[]) {
            position += 10;
            const r = await client.query(
                'UPDATE categories SET sort_order = $1 WHERE id = $2 AND store_id = $3',
                [position, id, storeId],
            );
            updated += r.rowCount ?? 0;
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'Order saved', updated });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('Error reordering categories:', error);
        res.status(500).json({ message: 'Error reordering categories' });
    } finally {
        client.release();
    }
};
