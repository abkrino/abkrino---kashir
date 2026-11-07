/**
 * Firestore Security Rules Unit Tests
 * Uses @firebase/rules-unit-testing to validate multi-tenant isolation, RBAC,
 * subscription status enforcement, and collection group query permissions.
 *
 * NOTE: Requires Firestore Emulator (firebase emulators:start --only firestore).
 * Run with: npx vitest run tests/firestore-rules.test.ts
 */

import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, collectionGroup, getDocs, serverTimestamp } from 'firebase/firestore';

const PROJECT_ID = 'abkrino-ai-rules-test';
const RULES_PATH = resolve(__dirname, '../firestore.rules');

describe('Firestore Multi-Tenant Security Rules', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    const rules = readFileSync(RULES_PATH, 'utf8');
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules,
        host: '127.0.0.1',
        port: 8080,
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    if (testEnv) {
      await testEnv.clearFirestore();

      // Seed baseline data using withSecurityRulesDisabled (Admin context)
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();

        // 1. Superadmin document
        await setDoc(doc(db, 'admins', 'admin_123'), {
          uid: 'admin_123',
          email: 'mahmoud.mansour0b@gmail.com',
          role: 'superadmin',
          createdAt: new Date(),
        });

        // 2. Active Organization (orgA)
        const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        await setDoc(doc(db, 'orgs', 'orgA'), {
          orgId: 'orgA',
          name: 'سوبر ماركت الخير والبركة',
          ownerEmail: 'ownerA@example.com',
          plan: 'باقة احترافية',
          maxBranches: 3,
          status: 'active',
          validUntil: futureDate,
          createdAt: new Date(),
        });

        // Active Branch for orgA
        await setDoc(doc(db, 'orgs', 'orgA', 'branches', 'branch_1'), {
          branchId: 'branch_1',
          name: 'الفرع الرئيسي',
          governorate: 'الجيزة',
          deviceId: 'dev-101',
          appVersion: '1.0.0',
          windowsVersion: '10+',
          mode: 'offline',
          lastSeenAt: new Date(),
          status: 'active',
        });

        // 3. Expired Organization (orgExpired)
        const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        await setDoc(doc(db, 'orgs', 'orgExpired'), {
          orgId: 'orgExpired',
          name: 'ماركت منتهي الصلاحية',
          ownerEmail: 'expired@example.com',
          plan: 'باقة تجريبية',
          maxBranches: 1,
          status: 'suspended',
          validUntil: pastDate,
          createdAt: pastDate,
        });

        await setDoc(doc(db, 'orgs', 'orgExpired', 'branches', 'branch_exp'), {
          branchId: 'branch_exp',
          name: 'فرع منتهي',
          governorate: 'القاهرة',
          deviceId: 'dev-999',
          appVersion: '1.0.0',
          windowsVersion: '7',
          mode: 'online',
          lastSeenAt: pastDate,
          status: 'inactive',
        });
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 1: عميل غريب أو غير مسجل ممنوع من القراءة والكتابة
  // ---------------------------------------------------------------------------
  it('1. عميل غريب أو غير مسجل ممنوع من الوصول لبيانات المحلات الأخرى', async () => {
    // Unauthenticated user
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthDb, 'orgs', 'orgA')));
    await assertFails(getDoc(doc(unauthDb, 'orgs', 'orgA', 'branches', 'branch_1')));

    // Authenticated user (userB) trying to access orgA
    const userBDb = testEnv.authenticatedContext('userB').firestore();
    await assertFails(getDoc(doc(userBDb, 'orgs', 'orgA')));
    await assertFails(getDoc(doc(userBDb, 'orgs', 'orgA', 'branches', 'branch_1')));
    await assertFails(
      setDoc(doc(userBDb, 'orgs', 'orgA', 'branches', 'branch_hacked'), {
        name: 'فرع غير مصرح',
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Test 2: صاحب اشتراك منتهٍ ممنوع من الكتابة وتحديث الحالة
  // ---------------------------------------------------------------------------
  it('2. صاحب اشتراك منتهٍ أو معلق ممنوع من إرسال نبضات الاتصال أو الملخص اليومي', async () => {
    const expiredOwnerDb = testEnv.authenticatedContext('orgExpired').firestore();

    // Owner can still read their own org and branch data
    await assertSucceeds(getDoc(doc(expiredOwnerDb, 'orgs', 'orgExpired')));

    // Owner cannot update heartbeat on branch because subscription is suspended/expired
    await assertFails(
      updateDoc(doc(expiredOwnerDb, 'orgs', 'orgExpired', 'branches', 'branch_exp'), {
        lastSeenAt: serverTimestamp(),
        appVersion: '1.0.1',
      })
    );

    // Owner cannot post daily summary
    await assertFails(
      setDoc(doc(expiredOwnerDb, 'orgs', 'orgExpired', 'branches', 'branch_exp', 'dailySummaries', '2026-11-07'), {
        salesTotal: 1000,
        invoiceCount: 10,
        cashInDrawer: 500,
        purchasesTotal: 200,
        customerDebt: 100,
        supplierDue: 0,
        lowStockCount: 0,
        updatedAt: new Date(),
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3: عميل لا يستطيع تعديل plan أو maxBranches
  // ---------------------------------------------------------------------------
  it('3. العميل ممنوع نهائياً من تعديل الخطة (plan) أو عدد الفروع (maxBranches) أو وثيقة orgs', async () => {
    const ownerADb = testEnv.authenticatedContext('orgA').firestore();

    // Attempt to modify organization plan or validUntil
    await assertFails(
      updateDoc(doc(ownerADb, 'orgs', 'orgA'), {
        plan: 'باقة مجانية مفتوحة',
        maxBranches: 999,
      })
    );

    // Attempt to update non-whitelisted branch fields (e.g. name or status)
    await assertFails(
      updateDoc(doc(ownerADb, 'orgs', 'orgA', 'branches', 'branch_1'), {
        name: 'اسم جديد للفرع',
        status: 'suspended',
      })
    );

    // Heartbeat update with non-serverTimestamp fails
    await assertFails(
      updateDoc(doc(ownerADb, 'orgs', 'orgA', 'branches', 'branch_1'), {
        lastSeenAt: new Date(2020, 1, 1),
        appVersion: '1.0.2',
        windowsVersion: '10+',
        mode: 'offline',
      })
    );

    // Updating ONLY whitelisted heartbeat fields with serverTimestamp() MUST succeed
    await assertSucceeds(
      updateDoc(doc(ownerADb, 'orgs', 'orgA', 'branches', 'branch_1'), {
        lastSeenAt: serverTimestamp(),
        appVersion: '1.0.2',
        windowsVersion: '10+',
        mode: 'offline',
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Test 4: كتابة سجل التراخيص licenseEvents ممنوعة للعميل
  // ---------------------------------------------------------------------------
  it('4. العميل يستطيع قراءة سجل التراخيص ولكن ممنوع منعاً باتاً من كتابة أي حدث ترخيص', async () => {
    const ownerADb = testEnv.authenticatedContext('orgA').firestore();

    // Client write is forbidden
    await assertFails(
      setDoc(doc(ownerADb, 'orgs', 'orgA', 'licenseEvents', 'fake_event'), {
        eventType: 'renew',
        durationDays: 365,
        newValidUntil: new Date(),
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Test 5: الأدمن يقرأ ويستعلم عن جميع المحلات والفروع (Collection Group Queries)
  // ---------------------------------------------------------------------------
  it('5. الأدمن يملك صلاحية القراءة الشاملة والاستعلامات المجمعة عبر كل الفروع', async () => {
    const adminDb = testEnv.authenticatedContext('admin_123').firestore();

    // Admin reads any org
    await assertSucceeds(getDoc(doc(adminDb, 'orgs', 'orgA')));
    await assertSucceeds(getDoc(doc(adminDb, 'orgs', 'orgExpired')));

    // Admin can create a new branch
    await assertSucceeds(
      setDoc(doc(adminDb, 'orgs', 'orgA', 'branches', 'branch_2'), {
        branchId: 'branch_2',
        name: 'فرع الإسكندرية',
        governorate: 'الإسكندرية',
        deviceId: 'dev-202',
        appVersion: '1.0.0',
        windowsVersion: '10+',
        mode: 'offline',
        lastSeenAt: new Date(),
        status: 'active',
      })
    );

    // Admin can query collectionGroup 'branches'
    await assertSucceeds(getDocs(collectionGroup(adminDb, 'branches')));
  });

  // ---------------------------------------------------------------------------
  // Test 6: بيانات orgsPrivate للأدمن فقط ومحجوبة تماماً عن العميل
  // ---------------------------------------------------------------------------
  it('6. orgsPrivate متاحة حصرياً للأدمن ومحجوبة تماماً عن صاحب المحل', async () => {
    const adminDb = testEnv.authenticatedContext('admin_123').firestore();
    const ownerADb = testEnv.authenticatedContext('orgA').firestore();

    // Admin can write and read orgsPrivate
    await assertSucceeds(
      setDoc(doc(adminDb, 'orgsPrivate', 'orgA'), {
        notes: 'ملاحظات داخلية سرية خاصة بإدارة المنظومة',
        internalBillingId: 'bill_999',
        supportContact: '01000000000',
      })
    );
    await assertSucceeds(getDoc(doc(adminDb, 'orgsPrivate', 'orgA')));

    // Client/Owner CANNOT read or write orgsPrivate
    await assertFails(getDoc(doc(ownerADb, 'orgsPrivate', 'orgA')));
    await assertFails(
      setDoc(doc(ownerADb, 'orgsPrivate', 'orgA'), {
        notes: 'محاولة اختراق الملاحظات',
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Test 7: النسخ الاحتياطية مقسمة لـ chunks والأدمن لا يصل لها
  // ---------------------------------------------------------------------------
  it('7. النسخ الاحتياطية مقسمة لقطع لا تتجاوز 900,000 بايت والأدمن ممنوع من قراءتها', async () => {
    const ownerADb = testEnv.authenticatedContext('orgA').firestore();
    const adminDb = testEnv.authenticatedContext('admin_123').firestore();

    const backupDocRef = doc(ownerADb, 'orgs', 'orgA', 'branches', 'branch_1', 'backups', 'backup_1');
    const validChunkRef = doc(ownerADb, 'orgs', 'orgA', 'branches', 'branch_1', 'backups', 'backup_1', 'chunks', '0');
    const hugeChunkRef = doc(ownerADb, 'orgs', 'orgA', 'branches', 'branch_1', 'backups', 'backup_1', 'chunks', '1');

    // Owner creates backup metadata
    await assertSucceeds(
      setDoc(backupDocRef, {
        id: 'backup_1',
        createdAt: new Date(),
        totalChunks: 2,
        totalBytes: 500000,
        appVersion: '1.0.0',
        deviceId: 'dev-101',
      })
    );

    // Owner writes valid chunk <= 900000 bytes
    const validData = 'a'.repeat(5000);
    await assertSucceeds(
      setDoc(validChunkRef, {
        index: 0,
        data: validData,
      })
    );

    // Owner writing chunk > 900000 bytes fails
    const hugeData = 'a'.repeat(900001);
    await assertFails(
      setDoc(hugeChunkRef, {
        index: 1,
        data: hugeData,
      })
    );

    // Admin has NO access to client backups or chunks
    const adminBackupRef = doc(adminDb, 'orgs', 'orgA', 'branches', 'branch_1', 'backups', 'backup_1');
    const adminChunkRef = doc(adminDb, 'orgs', 'orgA', 'branches', 'branch_1', 'backups', 'backup_1', 'chunks', '0');
    await assertFails(getDoc(adminBackupRef));
    await assertFails(getDoc(adminChunkRef));
  });
});
