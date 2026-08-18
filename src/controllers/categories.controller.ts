import express from 'express';
import db from '../db_client';
import { Category } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';


export const getCategories = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query('SELECT * FROM categories WHERE store_id = $1 ORDER BY name', [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ message: 'Error fetching categories' });
    }
};

export const createCategory = async (req: express.Request, res: express.Response) => {
    const { name, parentId, attributes, revenueAccountId, cogsAccountId } = req.body;
    const id = generateId('cat');

    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query(
            'INSERT INTO categories (id, name, parent_id, attributes, revenue_account_id, cogs_account_id, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [id, name, parentId || null, JSON.stringify(attributes || []), revenueAccountId, cogsAccountId, storeId]
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
    const { name, parentId, attributes, revenueAccountId, cogsAccountId } = req.body;
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query(
            'UPDATE categories SET name = $1, parent_id = $2, attributes = $3, revenue_account_id = $4, cogs_account_id = $5 WHERE id = $6 AND store_id = $7 RETURNING *',
            [name, parentId || null, JSON.stringify(attributes || []), revenueAccountId, cogsAccountId, id, storeId]
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
            return res.status(400).json({ message: 'Store context required' });
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
