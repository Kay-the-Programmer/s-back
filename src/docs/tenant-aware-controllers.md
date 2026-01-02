# Making Controllers Tenant-Aware

This document outlines the approach for making controllers tenant-aware in the multi-tenant POS system.

## Overview

In a multi-tenant system, each tenant's data must be isolated from other tenants. This is achieved by:

1. Attaching tenant information to each request via middleware
2. Filtering all database queries by the tenant's store ID
3. Including the store ID in all database write operations

## Implementation Steps

For each controller, follow these steps:

### 1. Add Tenant Context Check

At the beginning of each controller method, add:

```typescript
// Get store ID from tenant context
const storeId = req.tenant?.storeId;
if (!storeId) {
    return res.status(400).json({ message: 'Store context required' });
}
```

### 2. Filter Read Operations

For all SELECT queries, add a WHERE clause to filter by store_id:

```typescript
// Before
const result = await db.query('SELECT * FROM categories ORDER BY name');

// After
const result = await db.query('SELECT * FROM categories WHERE store_id = $1 ORDER BY name', [storeId]);
```

### 3. Include Store ID in Write Operations

For INSERT operations, add store_id to the column list and values:

```typescript
// Before
await db.query(
    'INSERT INTO categories (id, name, ...) VALUES ($1, $2, ...) RETURNING *',
    [id, name, ...]
);

// After
await db.query(
    'INSERT INTO categories (id, name, ..., store_id) VALUES ($1, $2, ..., $n) RETURNING *',
    [id, name, ..., storeId]
);
```

### 4. Filter Update and Delete Operations

For UPDATE and DELETE operations, add store_id to the WHERE clause:

```typescript
// Before
await db.query(
    'UPDATE categories SET name = $1, ... WHERE id = $2 RETURNING *',
    [name, ..., id]
);

// After
await db.query(
    'UPDATE categories SET name = $1, ... WHERE id = $2 AND store_id = $3 RETURNING *',
    [name, ..., id, storeId]
);
```

## Example

The products controller and categories controller have been updated to be tenant-aware and can serve as examples for updating other controllers.

## Testing

After updating a controller, test it to ensure:

1. It correctly filters data by tenant
2. It prevents cross-tenant data access
3. It associates new records with the correct tenant

## Security Considerations

- Always filter by store_id in WHERE clauses to prevent tenant data leakage
- Never allow a tenant to specify or override the store_id value
- Use the tenant context from the request, which is set by the tenant middleware