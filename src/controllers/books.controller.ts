/**
 * Books reports, computed on the server from the WHOLE ledger.
 *
 * The Books screens used to build the Profit & Loss and Journal from the newest
 * 1,000 journal entries (and Receivables / the tax report from the newest 1,000
 * sales) downloaded to the browser, so any period past that quietly lost its
 * older records. Every figure here comes from SQL over the full ledger for the
 * dates asked for.
 *
 * All routes are admin-only (mounted under /accounting).
 */
import express from 'express';
import db from '../db_client';
import { accountingService } from '../services/accounting.service';

const storeOf = (req: express.Request): string | undefined =>
    (req as any).tenant?.storeId || req.user?.currentStoreId;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** [from, to] as inclusive days; defaults to this month so far. */
const periodOf = (req: express.Request) => {
    const today = new Date();
    const from = isDay(req.query.from) ? req.query.from : ymd(new Date(today.getFullYear(), today.getMonth(), 1));
    const to = isDay(req.query.to) ? req.query.to : ymd(today);
    return { from, to };
};

/** Every account with its movement in [from, to] and its balance at the end of `asOf`. */
const accountFigures = async (storeId: string, from: string, to: string, asOf: string) => {
    await accountingService.ensureCoreAccounts(storeId);
    const { rows } = await db.query(
        `SELECT a.id, a.number, a.name, a.type, a.sub_type, a.is_debit_normal,
                COALESCE(SUM(CASE WHEN je.date >= $2::date AND je.date < ($3::date + 1)
                                  THEN CASE WHEN l.type = 'debit' THEN l.amount ELSE -l.amount END END), 0) AS period_net,
                COALESCE(SUM(CASE WHEN je.date < ($4::date + 1)
                                  THEN CASE WHEN l.type = 'debit' THEN l.amount ELSE -l.amount END END), 0) AS cumulative_net
           FROM accounts a
           LEFT JOIN journal_entry_lines l ON l.account_id = a.id AND l.store_id = a.store_id
           LEFT JOIN journal_entries je ON je.id = l.journal_entry_id AND je.store_id = a.store_id
          WHERE a.store_id = $1
          GROUP BY a.id
          ORDER BY a.number`,
        [storeId, from, to, asOf],
    );
    return rows.map((r: any) => ({
        id: r.id,
        number: r.number,
        name: r.name,
        type: r.type as 'asset' | 'liability' | 'equity' | 'revenue' | 'expense',
        subType: r.sub_type,
        debitNormal: !!r.is_debit_normal,
        periodNet: Number(r.period_net) || 0,        // debit-positive
        cumulativeNet: Number(r.cumulative_net) || 0, // debit-positive
    }));
};

/**
 * GET /accounting/statements?from&to&asOf
 * Profit & Loss for [from, to]; Balance Sheet and Trial Balance at the end of asOf.
 */
export const getStatements = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const { from, to } = periodOf(req);
        const asOf = isDay(req.query.asOf) ? req.query.asOf : to;
        const accts = await accountFigures(storeId, from, to, asOf);

        // ── Profit & Loss ──
        const line = (a: typeof accts[number], natural: number) => ({ id: a.id, number: a.number, name: a.name, subType: a.subType, amount: round2(natural) });
        const revenue = accts.filter(a => a.type === 'revenue').map(a => line(a, -a.periodNet)).filter(l => Math.abs(l.amount) >= 0.005);
        const expenses = accts.filter(a => a.type === 'expense').map(a => line(a, a.periodNet)).filter(l => Math.abs(l.amount) >= 0.005);
        const cogs = expenses.filter(e => e.subType === 'cogs');
        const operating = expenses.filter(e => e.subType !== 'cogs');
        const totalRevenue = round2(revenue.reduce((s, l) => s + l.amount, 0));
        const totalCogs = round2(cogs.reduce((s, l) => s + l.amount, 0));
        const totalOperating = round2(operating.reduce((s, l) => s + l.amount, 0));
        const grossProfit = round2(totalRevenue - totalCogs);
        const netProfit = round2(grossProfit - totalOperating);

        // ── Balance Sheet (as at asOf) ──
        const bal = (a: typeof accts[number]) => round2(a.debitNormal ? a.cumulativeNet : -a.cumulativeNet);
        const section = (type: string) => accts.filter(a => a.type === type)
            .map(a => ({ id: a.id, number: a.number, name: a.name, subType: a.subType, amount: bal(a) }))
            .filter(l => Math.abs(l.amount) >= 0.005);
        const assets = section('asset');
        const liabilities = section('liability');
        const equity = section('equity');
        // The books are not closed off each year, so all profit to date sits in
        // "earnings to date" until it is moved to equity.
        const earningsToDate = round2(
            accts.filter(a => a.type === 'revenue').reduce((s, a) => s - a.cumulativeNet, 0)
            - accts.filter(a => a.type === 'expense').reduce((s, a) => s + a.cumulativeNet, 0),
        );
        const totalAssets = round2(assets.reduce((s, l) => s + l.amount, 0));
        const totalLiabilities = round2(liabilities.reduce((s, l) => s + l.amount, 0));
        const totalEquity = round2(equity.reduce((s, l) => s + l.amount, 0) + earningsToDate);
        const difference = round2(totalAssets - totalLiabilities - totalEquity);

        // ── Trial Balance (as at asOf) ──
        const trial = accts
            .filter(a => Math.abs(a.cumulativeNet) >= 0.005)
            .map(a => ({
                id: a.id, number: a.number, name: a.name, type: a.type,
                debit: a.cumulativeNet > 0 ? round2(a.cumulativeNet) : 0,
                credit: a.cumulativeNet < 0 ? round2(-a.cumulativeNet) : 0,
            }));
        const trialDebit = round2(trial.reduce((s, t) => s + t.debit, 0));
        const trialCredit = round2(trial.reduce((s, t) => s + t.credit, 0));

        res.json({
            period: { from, to },
            asOf,
            profitAndLoss: { revenue, cogs, operating, totalRevenue, totalCogs, grossProfit, totalOperating, netProfit },
            balanceSheet: {
                assets, liabilities, equity, earningsToDate,
                totalAssets, totalLiabilities, totalEquity,
                balanced: Math.abs(difference) < 0.01, difference,
            },
            trialBalance: { rows: trial, totalDebit: trialDebit, totalCredit: trialCredit, balanced: Math.abs(trialDebit - trialCredit) < 0.01 },
        });
    } catch (e: any) {
        console.error('getStatements failed:', e?.message);
        res.status(500).json({ message: 'Could not build the statements.' });
    }
};

/**
 * GET /accounting/tax-report?from&to
 * VAT on sales by class (standard / zero / exempt), less VAT refunded, less VAT
 * paid on purchases (VAT Input) = VAT to pay.
 */
export const getTaxReport = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const { from, to } = periodOf(req);

        const sales = await db.query(
            `SELECT subtotal, discount, tax, tax_breakdown FROM sales
              WHERE store_id = $1 AND "timestamp" >= $2::date AND "timestamp" < ($3::date + 1)
                AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
            [storeId, from, to],
        );
        const byClass = new Map<string, { taxClass: string; ratePct: number; net: number; tax: number }>();
        for (const s of sales.rows) {
            let rows: any = s.tax_breakdown;
            if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = null; } }
            if (Array.isArray(rows) && rows.length) {
                for (const r of rows) {
                    const k = String(r.taxClass || 'standard');
                    const e = byClass.get(k) || { taxClass: k, ratePct: Number(r.ratePct) || 0, net: 0, tax: 0 };
                    e.net += Number(r.net) || 0;
                    e.tax += Number(r.tax) || 0;
                    if (k === 'standard') e.ratePct = Math.max(e.ratePct, Number(r.ratePct) || 0);
                    byClass.set(k, e);
                }
            } else {
                // Older sales without a breakdown: all standard-rated.
                const e = byClass.get('standard') || { taxClass: 'standard', ratePct: 0, net: 0, tax: 0 };
                e.net += (Number(s.subtotal) || 0) - (Number(s.discount) || 0);
                e.tax += Number(s.tax) || 0;
                byClass.set('standard', e);
            }
        }
        const order = ['standard', 'zero', 'exempt'];
        const output = [...byClass.values()]
            .map(e => ({ ...e, net: round2(e.net), tax: round2(e.tax) }))
            .sort((a, b) => order.indexOf(a.taxClass) - order.indexOf(b.taxClass));
        const outputTax = round2(output.reduce((s, e) => s + e.tax, 0));

        const refunds = await db.query(
            `SELECT COALESCE(SUM(tax_amount), 0) AS tax, COALESCE(SUM(subtotal_amount), 0) AS net
               FROM returns WHERE store_id = $1 AND "timestamp" >= $2::date AND "timestamp" < ($3::date + 1)`,
            [storeId, from, to],
        );
        const refundsTax = round2(refunds.rows[0].tax);
        const refundsNet = round2(refunds.rows[0].net);

        const input = await db.query(
            `SELECT COALESCE(SUM(CASE WHEN l.type = 'debit' THEN l.amount ELSE -l.amount END), 0) AS net
               FROM journal_entry_lines l
               JOIN journal_entries je ON je.id = l.journal_entry_id AND je.store_id = l.store_id
               JOIN accounts a ON a.id = l.account_id AND a.store_id = l.store_id
              WHERE l.store_id = $1 AND a.sub_type = 'vat_input'
                AND je.date >= $2::date AND je.date < ($3::date + 1)`,
            [storeId, from, to],
        );
        const inputTax = round2(input.rows[0].net);

        res.json({
            period: { from, to },
            salesCount: sales.rowCount,
            output, outputTax,
            refundsTax, refundsNet,
            inputTax,
            netPayable: round2(outputTax - refundsTax - inputTax),
        });
    } catch (e: any) {
        console.error('getTaxReport failed:', e?.message);
        res.status(500).json({ message: 'Could not build the tax report.' });
    }
};

/**
 * GET /accounting/journal?from&to&accountId&q&limit&offset
 * One page of journal entries, newest first. With accountId, also the
 * account's opening balance and a running balance after each entry.
 */
export const getJournalPage = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const { from, to } = periodOf(req);
        const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
        const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
        const accountId = typeof req.query.accountId === 'string' && req.query.accountId ? req.query.accountId : null;
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

        const where: string[] = ['je.store_id = $1', 'je.date >= $2::date', 'je.date < ($3::date + 1)'];
        const params: any[] = [storeId, from, to];
        if (accountId) {
            params.push(accountId);
            where.push(`EXISTS (SELECT 1 FROM journal_entry_lines x WHERE x.journal_entry_id = je.id AND x.account_id = $${params.length})`);
        }
        if (q) {
            params.push(`%${q}%`);
            where.push(`je.description ILIKE $${params.length}`);
        }
        const whereSql = where.join(' AND ');

        const total = Number((await db.query(`SELECT COUNT(*) FROM journal_entries je WHERE ${whereSql}`, params)).rows[0].count) || 0;
        const page = await db.query(
            `SELECT je.id, je.date, je.description, je.source_type, je.source_id,
                    COALESCE(json_agg(json_build_object('accountId', l.account_id, 'accountName', l.account_name, 'type', l.type, 'amount', l.amount)
                             ORDER BY l.type DESC) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
               FROM journal_entries je
               LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id AND l.store_id = je.store_id
              WHERE ${whereSql}
              GROUP BY je.id
              ORDER BY je.date DESC, je.id DESC
              LIMIT ${limit} OFFSET ${offset}`,
            params,
        );

        let items = page.rows.map((r: any) => ({
            id: r.id, date: r.date, description: r.description, sourceType: r.source_type, sourceId: r.source_id,
            lines: (r.lines || []).map((l: any) => ({ ...l, amount: Number(l.amount) || 0 })),
        }));

        let account: any = null;
        if (accountId) {
            const acc = await db.query('SELECT id, number, name, is_debit_normal FROM accounts WHERE id = $1 AND store_id = $2', [accountId, storeId]);
            if (acc.rowCount) {
                const debitNormal = !!acc.rows[0].is_debit_normal;
                // Balance at the end of `to`, then walk back through this page.
                const closing = await db.query(
                    `SELECT COALESCE(SUM(CASE WHEN l.type = 'debit' THEN l.amount ELSE -l.amount END), 0) AS net
                       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id AND je.store_id = l.store_id
                      WHERE l.store_id = $1 AND l.account_id = $2 AND je.date < ($3::date + 1)`,
                    [storeId, accountId, to],
                );
                // Entries newer than this page (within the period) come off first.
                let newerNet = 0;
                if (offset > 0) {
                    const newerIds = (await db.query(
                        `SELECT je.id FROM journal_entries je WHERE ${whereSql} ORDER BY je.date DESC, je.id DESC LIMIT ${offset}`,
                        params,
                    )).rows.map((r: any) => r.id);
                    if (newerIds.length) {
                        const r = await db.query(
                            `SELECT COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END), 0) AS net
                               FROM journal_entry_lines WHERE store_id = $1 AND account_id = $2 AND journal_entry_id = ANY($3::text[])`,
                            [storeId, accountId, newerIds],
                        );
                        newerNet = Number(r.rows[0].net) || 0;
                    }
                }
                let running = (Number(closing.rows[0].net) || 0) - newerNet;
                const sign = debitNormal ? 1 : -1;
                items = items.map(e => {
                    const after = running;
                    const move = e.lines.filter((l: any) => l.accountId === accountId)
                        .reduce((s: number, l: any) => s + (l.type === 'debit' ? l.amount : -l.amount), 0);
                    running -= move;
                    return { ...e, accountMovement: round2(sign * move), accountBalanceAfter: round2(sign * after) };
                });
                account = { id: acc.rows[0].id, number: acc.rows[0].number, name: acc.rows[0].name, debitNormal };
            }
        }

        res.json({ period: { from, to }, total, limit, offset, items, account });
    } catch (e: any) {
        console.error('getJournalPage failed:', e?.message);
        res.status(500).json({ message: 'Could not load the journal.' });
    }
};

/**
 * GET /accounting/takings?from&to
 * Money in and out of Cash on Hand, Mobile Money and Bank for the period,
 * with each one's balance at the end — the figures to check against the
 * drawer count and the MoMo / bank statements.
 */
export const getTakings = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const { from, to } = periodOf(req);
        await accountingService.ensureCoreAccounts(storeId);
        const { rows } = await db.query(
            `SELECT a.id, a.name, a.sub_type,
                    COALESCE(SUM(CASE WHEN l.type = 'debit' AND je.date >= $2::date AND je.date < ($3::date + 1) THEN l.amount END), 0) AS money_in,
                    COALESCE(SUM(CASE WHEN l.type = 'credit' AND je.date >= $2::date AND je.date < ($3::date + 1) THEN l.amount END), 0) AS money_out,
                    COALESCE(SUM(CASE WHEN je.date < ($3::date + 1) THEN CASE WHEN l.type = 'debit' THEN l.amount ELSE -l.amount END END), 0) AS balance
               FROM accounts a
               LEFT JOIN journal_entry_lines l ON l.account_id = a.id AND l.store_id = a.store_id
               LEFT JOIN journal_entries je ON je.id = l.journal_entry_id AND je.store_id = a.store_id
              WHERE a.store_id = $1 AND a.sub_type IN ('cash', 'mobile_money', 'bank')
              GROUP BY a.id ORDER BY a.number`,
            [storeId, from, to],
        );
        res.json({
            period: { from, to },
            accounts: rows.map((r: any) => ({
                id: r.id, name: r.name, subType: r.sub_type,
                moneyIn: round2(r.money_in), moneyOut: round2(r.money_out), balance: round2(r.balance),
            })),
        });
    } catch (e: any) {
        console.error('getTakings failed:', e?.message);
        res.status(500).json({ message: 'Could not load takings.' });
    }
};

/**
 * GET /accounting/health
 * Do the books agree with the records behind them? Each control account is
 * compared with its own records; any gap is shown with what to do about it.
 */
export const getBooksHealth = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        await accountingService.ensureCoreAccounts(storeId);

        const gl = async (sub: string, creditNormal = false) => {
            const r = await db.query(
                `SELECT COALESCE(SUM(CASE WHEN l.type = 'debit' THEN l.amount ELSE -l.amount END), 0) AS net
                   FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id AND a.store_id = l.store_id
                  WHERE l.store_id = $1 AND a.sub_type = $2`, [storeId, sub]);
            const n = Number(r.rows[0].net) || 0;
            return round2(creditNormal ? -n : n);
        };
        const one = async (sql: string) => round2(Number(Object.values((await db.query(sql, [storeId])).rows[0])[0]) || 0);

        const checks = [
            {
                key: 'inventory', label: 'Stock value',
                ledger: await gl('inventory'),
                records: await one(`SELECT COALESCE(SUM(stock * cost_price), 0) FROM products WHERE store_id = $1 AND status = 'active'`),
                hint: 'Stock was added or valued without a matching entry (for example before costs were set). Do a stock take, or post an opening-stock adjustment.',
            },
            {
                key: 'receivables', label: 'Customers owe you',
                ledger: await gl('accounts_receivable'),
                records: await one(`SELECT COALESCE(SUM(account_balance), 0) FROM customers WHERE store_id = $1`),
                hint: 'A customer balance was changed outside an invoice, payment or refund. Check recent manual entries.',
            },
            {
                key: 'payables', label: 'You owe suppliers',
                ledger: await gl('accounts_payable', true),
                records: await one(`SELECT COALESCE(SUM(amount - amount_paid), 0) FROM supplier_invoices WHERE store_id = $1`),
                hint: 'Supplier bills from before 16 Nov 2026 may still be at the full order value. Run the bill reconciliation.',
            },
            {
                key: 'store_credit', label: 'Store credit held for customers',
                ledger: await gl('store_credit_payable', true),
                records: await one(`SELECT COALESCE(SUM(store_credit), 0) FROM customers WHERE store_id = $1`),
                hint: 'Store credit was changed on a customer without a matching entry.',
            },
        ].map(c => ({ ...c, difference: round2(c.ledger - c.records), ok: Math.abs(c.ledger - c.records) < 0.01 }));

        const unbalanced = Number((await db.query(
            `SELECT COUNT(*) FROM (SELECT journal_entry_id FROM journal_entry_lines WHERE store_id = $1
               GROUP BY journal_entry_id HAVING ABS(SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END)) > 0.01) x`,
            [storeId])).rows[0].count) || 0;

        res.json({
            checks,
            unbalancedEntries: unbalanced,
            allOk: unbalanced === 0 && checks.every(c => c.ok),
            lockedUntil: await accountingService.booksLockedUntil(storeId),
        });
    } catch (e: any) {
        console.error('getBooksHealth failed:', e?.message);
        res.status(500).json({ message: 'Could not check the books.' });
    }
};

/** GET /accounting/lock — PUT /accounting/lock { lockedUntil: 'YYYY-MM-DD' | null } */
export const getBooksLock = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
    res.json({ lockedUntil: await accountingService.booksLockedUntil(storeId) });
};

export const setBooksLock = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const value = req.body?.lockedUntil ?? null;
        if (value !== null && !isDay(value)) return res.status(400).json({ message: 'Give a date as YYYY-MM-DD, or null to reopen.' });
        if (value && value >= ymd(new Date())) {
            return res.status(400).json({ message: 'You can only close periods that have already ended — pick a date before today.' });
        }
        await db.query('UPDATE store_settings SET books_locked_until = $1 WHERE store_id = $2', [value, storeId]);
        res.json({ lockedUntil: value });
    } catch (e: any) {
        console.error('setBooksLock failed:', e?.message);
        res.status(500).json({ message: 'Could not update the period lock.' });
    }
};
