/**
 * Multi-Tenant & Multi-Branch Cloud Firestore Architecture Types
 * Defines schemas for Superadmins, Organizations (Merchants/Chains), Branches,
 * Daily Operational Summaries, Chunked Backups, and License Audit Events.
 */

// Universal Timestamp representation compatible with Firestore Timestamp and ISO strings
export type CloudTimestamp = 
  | string 
  | Date 
  | { seconds: number; nanoseconds: number };

// ---------------------------------------------------------------------------
// 1. Superadmin Types (admins/{uid})
// Created manually in Firebase Console. No client-side write access.
// ---------------------------------------------------------------------------
export interface AdminDoc {
  uid: string;
  email: string;
  role: 'superadmin';
  createdAt: CloudTimestamp;
}

// ---------------------------------------------------------------------------
// 2. Organization / Merchant Types (orgs/{orgId})
// orgId = Firebase Auth UID of the store owner's primary email.
// Read: Owner or Superadmin.
// Write: Superadmin ONLY. Client cannot modify plan or subscription fields.
// ---------------------------------------------------------------------------
export type OrgStatus = 'pending' | 'active' | 'suspended';

export interface OrganizationDoc {
  orgId: string;                // Primary Auth UID
  name: string;                 // Store or Chain Name
  ownerEmail: string;           // Primary account email
  plan: string;                 // e.g. 'سوبر ماركت - باقة احترافية كاملة'
  maxBranches: number;          // Maximum allowed active branches (e.g. 1, 5, 20)
  status: OrgStatus;            // 'pending' | 'active' | 'suspended'
  validUntil: CloudTimestamp;   // Subscription expiration timestamp
  createdAt: CloudTimestamp;    // Registration timestamp
}

// ---------------------------------------------------------------------------
// 2b. Organization Private Data (orgsPrivate/{orgId})
// Accessible strictly by Superadmins. Contains administrative notes, internal tags, billing.
// ---------------------------------------------------------------------------
export interface OrgPrivateDoc {
  orgId: string;
  notes?: string;               // Administrative private notes
  internalTags?: string[];      // e.g. ['vip', 'high-volume', 'late-payer']
  internalBillingInfo?: Record<string, unknown>;
  updatedAt?: CloudTimestamp;
}

// ---------------------------------------------------------------------------
// 3. Branch Types (orgs/{orgId}/branches/{branchId})
// Create / Delete: Superadmin ONLY.
// Update: Client (Owner) allowed ONLY for heartbeat and diagnostic fields:
//         ['lastSeenAt', 'appVersion', 'windowsVersion', 'mode']
// ---------------------------------------------------------------------------
export type BranchMode = 'offline' | 'online';
export type BranchStatus = 'active' | 'inactive' | 'maintenance';

export interface BranchDoc {
  branchId: string;             // Branch Identifier (e.g. 'main-branch', 'branch-nasr-city')
  name: string;                 // Branch Display Name
  governorate: string;          // Egyptian Governorate (e.g. 'القاهرة', 'الجيزة', 'الإسكندرية')
  deviceId: string;             // Linked Machine Hardware / Device Identifier
  appVersion: string;           // Installed Application Version (e.g. '1.0.0')
  windowsVersion: string;       // OS info ('7' | '8' | '8.1' | '10+' | 'non-windows')
  mode: BranchMode;             // 'offline' | 'online'
  lastSeenAt: CloudTimestamp;   // Periodic heartbeat timestamp
  status: BranchStatus;         // Administrative branch status
  createdAt?: CloudTimestamp;   // Branch creation timestamp
}

// Client Heartbeat Payload (Fields allowed for update by store client)
export interface BranchHeartbeatUpdate {
  lastSeenAt: CloudTimestamp;
  appVersion: string;
  windowsVersion: string;
  mode: BranchMode;
}

// ---------------------------------------------------------------------------
// 4. Daily Operational Summary (orgs/{orgId}/branches/{branchId}/dailySummaries/{yyyy-MM-dd})
// Written at end of shift / day by store client (or synced on reconnect).
// Keyed strictly by date formatted as 'YYYY-MM-DD'.
// ---------------------------------------------------------------------------
export interface DailySummaryDoc {
  yyyyMMdd: string;             // Document ID matching 'YYYY-MM-DD'
  salesTotal: number;           // Total Sales Revenue (EGP)
  invoiceCount: number;         // Count of completed sales invoices
  cashInDrawer: number;         // Current physical cash in drawer (EGP)
  purchasesTotal: number;       // Total purchasing expenses (EGP)
  customerDebt: number;         // Total active customer balance / credit book (EGP)
  supplierDue: number;          // Total outstanding balance owed to dairy & suppliers (EGP)
  lowStockCount: number;        // Count of SKUs with stock <= reorder limit
  updatedAt: CloudTimestamp;    // Synchronization timestamp
}

// ---------------------------------------------------------------------------
// 5. Chunked Backups (orgs/{orgId}/branches/{branchId}/backups/{id})
// Split into chunks to support large databases within Firestore 1MB doc limits.
// ---------------------------------------------------------------------------
export interface BackupMetadata {
  createdAt: CloudTimestamp;
  sizeBytes: number;
  appVersion: string;
  note?: string;
  totalInvoices?: number;
  totalProducts?: number;
  totalChunks: number;
}

// Backup Metadata Document (stored at orgs/{orgId}/branches/{branchId}/backups/{id})
export interface BackupDoc {
  id: string;
  metadata: BackupMetadata;
}

// Backup Chunk Document (stored at orgs/{orgId}/branches/{branchId}/backups/{id}/chunks/{chunkIndex})
// Each chunk contains serialized string data with max 900,000 bytes.
export interface BackupChunkDoc {
  chunkIndex: number;
  data: string;                 // Serialized JSON chunk <= 900,000 bytes
  createdAt?: CloudTimestamp;
}

// ---------------------------------------------------------------------------
// 6. License Audit Events (orgs/{orgId}/licenseEvents/{id})
// Written EXCLUSIVELY by server / Admin SDK during key generation and renewals.
// Read: Store Owner and Superadmin.
// ---------------------------------------------------------------------------
export type LicenseEventType = 'issue' | 'renew' | 'revoke' | 'upgrade';

export interface LicenseEventDoc {
  id: string;
  eventType: LicenseEventType;
  targetDeviceId: string;
  branchId: string;
  plan: string;
  durationDays: number;
  previousValidUntil?: CloudTimestamp;
  newValidUntil: CloudTimestamp;
  createdBy: string;           // Admin UID or server worker
  createdAt: CloudTimestamp;
  notes?: string;
}

// ---------------------------------------------------------------------------
// 7. Aggregated Dashboard View Types (for Superadmin Dashboard)
// ---------------------------------------------------------------------------
export interface SuperadminOrgSummary extends OrganizationDoc {
  activeBranchesCount: number;
  lastActiveBranchDate?: CloudTimestamp;
  todayTotalSales?: number;
}

export interface SuperadminBranchView extends BranchDoc {
  orgId: string;
  orgName: string;
  isOnlineHeartbeat: boolean;
  todaySummary?: DailySummaryDoc;
}
