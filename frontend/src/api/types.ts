export type Role = 'OPERATOR' | 'SUPERVISOR';
export type DocumentStatus = 'OPEN' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED' | 'COMPLETED' | 'CANCELLED';

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: Role;
}
export interface Page<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  isActive: boolean;
}
export interface DocumentSummary {
  id: number;
  documentNumber: string;
  supplierName: string;
  referenceNumber: string | null;
  expectedDate: string | null;
  status: DocumentStatus;
  itemCount: number;
  totalExpected: number;
  totalReceived: number;
  createdAt: string;
}
export interface DocumentItem {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  expectedQuantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
}
export interface Receipt {
  id: number;
  receivedBy: { id: number; fullName: string };
  createdAt: string;
  lines: Array<{ itemId: number; productId: number; sku: string; quantity: number; balanceAfter: number }>;
}
export interface ReceivingDocument extends DocumentSummary {
  notes: string | null;
  createdBy: { id: number; fullName: string };
  completedAt: string | null;
  completedBy: { id: number; fullName: string } | null;
  cancelledAt: string | null;
  cancelledBy: { id: number; fullName: string } | null;
  items: DocumentItem[];
  receipts: Receipt[];
}
export interface InventoryItem {
  productId: number;
  sku: string;
  name: string;
  isActive: boolean;
  quantityOnHand: number;
  updatedAt: string | null;
}
export interface InventoryTransaction {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  type: 'RECEIPT';
  quantityChange: number;
  balanceAfter: number;
  documentId: number;
  documentNumber: string;
  receiptId: number;
  createdBy: { id: number; fullName: string };
  createdAt: string;
}
