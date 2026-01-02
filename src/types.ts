

export interface Product {
  id: string;
  name: string;
  description: string;
  sku: string;
  barcode?: string;
  // DEPRECATED: category: string;
  categoryId?: string;
  price: number; // Retail Price
  costPrice?: number;
  stock: number;
  unitOfMeasure?: 'unit' | 'kg';
  imageUrls: string[];
  supplierId?: string;
  brand?: string;
  weight?: number; // in kg
  dimensions?: string; // e.g., "W x H x D cm"
  reorderPoint?: number;
  safetyStock?: number;
  status: 'active' | 'archived';
  customAttributes?: { [attributeId: string]: string };
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'superadmin' | 'admin' | 'staff' | 'inventory_manager';
  currentStoreId?: string; // Multi-tenant: currently selected store ID
}

export interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  stock: number; // To check against when increasing quantity
  returnedQuantity?: number;
  costPrice?: number; // Cost of the item at the time of sale
}

export interface Customer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  notes?: string;
  createdAt: string;
  storeCredit: number;
  accountBalance: number; // A/R Balance
}

export interface Payment {
    id: string;
    date: string;
    amount: number;
    method: string;
}

export interface Sale {
  transactionId: string;
  timestamp: string;
  cart: CartItem[];
  total: number;
  subtotal: number;
  tax: number;
  discount: number;
  storeCreditUsed?: number;
  refundStatus: 'none' | 'partially_refunded' | 'fully_refunded';
  customerId?: string;
  customerName?: string;
  // New fields for invoicing
  paymentStatus: 'paid' | 'unpaid' | 'partially_paid';
  amountPaid: number;
  dueDate?: string;
  payments?: Payment[];
}

export interface Return {
  id: string;
  originalSaleId: string;
  timestamp: string;
  returnedItems: {
    productId: string;
    productName: string;
    quantity: number;
    reason: string;
    addToStock: boolean;
  }[];
  refundAmount: number;
  refundMethod: string;
}


export interface CustomAttribute {
    id: string;
    name: string;
}

export interface Category {
    id: string;
    name: string;
    parentId: string | null;
    attributes: CustomAttribute[];
    revenueAccountId?: string;
    cogsAccountId?: string;
}

export interface CountedItem {
  productId: string;
  name:string;
  sku: string;
  expected: number;
  counted: number | null; // null means not yet counted
}

export interface StockTakeSession {
  id: string;
  startTime: string;
  endTime?: string;
  status: 'active' | 'completed';
  items: CountedItem[];
}

export interface Supplier {
  id: string;
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  paymentTerms?: string;
  bankingDetails?: string;
  notes?: string;
}

export interface POItem {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  costPrice: number; // Cost at time of order
  receivedQuantity: number;
}

export interface ReceptionEvent {
  date: string;
  items: {
    productId: string;
    productName: string;
    quantityReceived: number;
  }[];
}

export interface PurchaseOrder {
  id: string;
  poNumber: string; // e.g., PO-2024-001
  supplierId: string;
  supplierName: string; // denormalized for easy display
  status: 'draft' | 'ordered' | 'partially_received' | 'received' | 'canceled';
  items: POItem[];
  createdAt: string;
  orderedAt?: string;
  expectedAt?: string;
  receivedAt?: string;
  notes?: string;
  subtotal: number;
  shippingCost: number;
  tax: number;
  total: number;
  receptions?: ReceptionEvent[];
}

export interface StoreSettings {
    // Store Information
    name: string;
    address: string;
    phone: string;
    email: string;
    website: string;

    // Financial
    taxRate: number; // as a percentage, e.g., 10 for 10%
    currency: {
        symbol: string; // e.g., '$'
        code: string; // e.g., 'USD'
        position: 'before' | 'after';
    };
    
    // Receipt
    receiptMessage: string; // "Thank you for your purchase!"

    // Inventory
    lowStockThreshold: number; // Default reorder point if not set on product
    skuPrefix: string; // e.g., 'SP-'

    // POS
    enableStoreCredit: boolean;
    paymentMethods: { id: string; name: string; }[];
    supplierPaymentMethods: { id: string; name: string; }[];
}

// --- Accounting Types ---

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface Account {
    id: string;
    name: string;
    number: string; // e.g., '1010'
    type: AccountType;
    // Special sub-type for automatic transaction mapping
    subType?: 'cash' | 'accounts_receivable' | 'inventory' | 'accounts_payable' | 'sales_tax_payable' | 'sales_revenue' | 'cogs' | 'store_credit_payable' | 'inventory_adjustment';
    balance: number;
    isDebitNormal: boolean; // true for assets, expenses. false for liability, equity, revenue
    description: string;
}

export interface JournalEntryLine {
    accountId: string;
    type: 'debit' | 'credit';
    amount: number;
    accountName: string; // denormalized for display
}

export interface JournalEntry {
    id: string;
    date: string;
    description: string;
    lines: JournalEntryLine[];
    source: {
        type: 'sale' | 'purchase' | 'manual' | 'payment';
        id?: string; // e.g., sale.transactionId or po.id
    };
}

export interface SupplierPayment {
    id: string;
    date: string;
    amount: number;
    method: string;
    reference?: string; // e.g., check number
}

export interface SupplierInvoice {
    id: string;
    invoiceNumber: string; // From the supplier
    supplierId: string;
    supplierName: string;
    purchaseOrderId: string;
    poNumber: string;
    invoiceDate: string;
    dueDate: string;
    amount: number;
    amountPaid: number;
    status: 'unpaid' | 'partially_paid' | 'paid' | 'overdue';
    payments: SupplierPayment[];
}


// --- System Types ---

export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  action: string;
  details: string; // e.g., "Product: 'Coffee Mug' (SKU: 12345)"
  storeId?: string; // tenant scope
}