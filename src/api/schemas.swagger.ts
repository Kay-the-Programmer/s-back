/**
 * @openapi
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "u123"
 *         name:
 *           type: string
 *           example: "John Doe"
 *         email:
 *           type: string
 *           format: email
 *           example: "john@example.com"
 *         role:
 *           type: string
 *           enum: [superadmin, admin, staff, inventory_manager, customer]
 *           example: "admin"
 *         currentStoreId:
 *           type: string
 *           example: "s456"
 *         isVerified:
 *           type: boolean
 *           example: true
 *
 *     Product:
 *       type: object
 *       required:
 *         - name
 *         - price
 *         - stock
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *           example: "Premium Coffee Beans"
 *         description:
 *           type: string
 *         sku:
 *           type: string
 *           example: "COF-001"
 *         barcode:
 *           type: string
 *         price:
 *           type: number
 *           example: 15.99
 *         costPrice:
 *           type: number
 *         stock:
 *           type: number
 *           example: 100
 *         status:
 *           type: string
 *           enum: [active, archived]
 *
 *     Sale:
 *       type: object
 *       properties:
 *         transactionId:
 *           type: string
 *         timestamp:
 *           type: string
 *           format: date-time
 *         total:
 *           type: number
 *         subtotal:
 *           type: number
 *         tax:
 *           type: number
 *         discount:
 *           type: number
 *         paymentStatus:
 *           type: string
 *           enum: [paid, unpaid, partially_paid]
 *
 *     Error:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *           example: "An error occurred"
 *         stack:
 *           type: string
 */
export {};
