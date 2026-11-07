# مخطط قاعدة بيانات Firestore للنظام متعدد المحلات والفروع (Multi-Tenant & Multi-Branch Architecture)

يوثق هذا الدليل الهيكل الهرمي وقواعد الأمان والفهارس المركبة لقاعدة بيانات **Cloud Firestore**، والمصممة خصيصاً لإدارة شبكات السوبر ماركت وتجارة الجملة والتجزئة وتوزيع الألبان متعددة الفروع، بحيث تُبنى عليها لوحة تحكم مركزية (Superadmin Dashboard) مستقبلاً دون الحاجة لأي تعديل على هيكل البيانات.

---

## 1. الهيكل الهرمي للمجموعات (Collections Hierarchy)

```text
firestore-root
│
├── admins/ {uid}
│
└── orgs/ {orgId}                     (orgId = UID الخاص بحساب المالك)
    │
    ├── branches/ {branchId}          (الفروع ونقاط البيع المرتبطة بالمحل)
    │   │
    │   ├── dailySummaries/ {yyyy-MM-dd}  (الملخصات والتقارير المالية اليومية)
    │   │
    │   └── backups/ {id}             (النسخ الاحتياطية المقسمة Chunks)
    │
    └── licenseEvents/ {id}           (سجل وتدقيق إصدار وتجديد التراخيص)
```

---

## 2. تفاصيل المجموعات وأمثلة الوثائق (Document Examples)

### أ) مجموعة مديري النظام: `admins/{uid}`
* **الغرض:** تحديد الحسابات المخولة بإدارة النظام والاشتراكات.
* **التحكم:** تُنشأ وتُعدل يدوياً فقط من **Firebase Console**، وممنوع الكتابة عليها من أي عميل.
* **مثال الوثيقة (`admins/admin_uid_101`):**
```json
{
  "uid": "admin_uid_101",
  "email": "mahmoud.mansour0b@gmail.com",
  "role": "superadmin",
  "createdAt": "2026-11-01T10:00:00.000Z"
}
```

---

### ب) مجموعة المنشآت والمحلات: `orgs/{orgId}`
* **الغرض:** تمثيل المحل أو سلسلة المحلات المربوطة بإيميل المالك الأساسي (`orgId = request.auth.uid`).
* **الصلاحيات:**
  * **قراءة:** صاحب الحساب (`request.auth.uid == orgId`) أو الأدمن.
  * **كتابة:** الأدمن فقط (العميل لا يملك صلاحية تغيير الخطة أو عدد الفروع أو تمديد الاشتراك).
* **مثال الوثيقة (`orgs/mahmoud_user_uid`):**
```json
{
  "orgId": "mahmoud_user_uid",
  "name": "سوبر ماركت وماركت الألبان الخير والبركة",
  "ownerEmail": "mahmoud.mansour0b@gmail.com",
  "plan": "سوبر ماركت - باقة احترافية كاملة (سلسلة فروع)",
  "maxBranches": 5,
  "status": "active",
  "validUntil": "2027-11-07T16:00:00.000Z",
  "createdAt": "2026-11-01T12:00:00.000Z"
}
```

---

### ب-2) مجموعة البيانات الإدارية الخاصة: `orgsPrivate/{orgId}`
* **الغرض:** حفظ الملاحظات الإدارية (`notes`) والبيانات المالية والوسوم الداخلية (`tags`) التي تخص المنشأة.
* **الصلاحيات:** قراءة وكتابة محصورة **بالكامل للسوبر أدمن**، والعميل لا يملك أي حق قراءة أو كتابة هنا.
* **مثال الوثيقة (`orgsPrivate/mahmoud_user_uid`):**
```json
{
  "orgId": "mahmoud_user_uid",
  "notes": "الفرع الرئيسي + فروع التوزيع في الجيزة والقاهرة، عميل موثوق",
  "internalTags": ["vip", "supermarket-chain"],
  "updatedAt": "2026-11-01T12:00:00.000Z"
}
```

---

### ج) مجموعة الفروع: `orgs/{orgId}/branches/{branchId}`
* **الغرض:** إدارة كل فرع أو ماكينة كاشير داخل المحل، ومتابعة نبضات الاتصال وحالة النظام ونظام التشغيل.
* **الصلاحيات:**
  * **إنشاء وحذف:** الأدمن فقط.
  * **تعديل:** الأدمن أو صاحب الحساب إذا كان اشتراكه سارياً (`status == 'active'` و `validUntil > request.time`)، ومحصور في 4 حقول فقط:
    `lastSeenAt`, `appVersion`, `windowsVersion`, `mode`
* **مثال الوثيقة (`orgs/mahmoud_user_uid/branches/main-branch`):**
```json
{
  "branchId": "main-branch",
  "name": "الفرع الرئيسي (ماركت وقسم الألبان)",
  "governorate": "الجيزة",
  "deviceId": "dev-eaed5535-c9c4",
  "appVersion": "1.0.0",
  "windowsVersion": "10+",
  "mode": "offline",
  "lastSeenAt": "2026-11-07T16:10:00.000Z",
  "status": "active",
  "createdAt": "2026-11-01T12:30:00.000Z"
}
```

---

### د) ملخص العمليات اليومية: `orgs/{orgId}/branches/{branchId}/dailySummaries/{yyyy-MM-dd}`
* **الغرض:** حفظ الإحصائيات التجميعية ليوم العمل بدلاً من تحميل مئات الفواتير، مما يمنح لوحة التحكم سرعة لحظية وتوفيراً كبيراً في استهلاك القراءات.
* **معرّف الوثيقة:** تاريخ اليوم بصيغة صارمة `YYYY-MM-DD` (مثل `2026-11-07`).
* **الصلاحيات:** قراءة وكتابة لصاحب الحساب باشتراك سارٍ، وقراءة للأدمن.
* **مثال الوثيقة (`orgs/mahmoud_user_uid/branches/main-branch/dailySummaries/2026-11-07`):**
```json
{
  "yyyyMMdd": "2026-11-07",
  "salesTotal": 45280.50,
  "invoiceCount": 142,
  "cashInDrawer": 12850.00,
  "purchasesTotal": 18400.00,
  "customerDebt": 9650.00,
  "supplierDue": 24000.00,
  "lowStockCount": 6,
  "updatedAt": "2026-11-07T22:30:00.000Z"
}
```

---

### هـ) النسخ الاحتياطية المقسمة: `orgs/{orgId}/branches/{branchId}/backups/{id}`
* **الهيكل:** كل عملية نسخ احتياطي تتكون من وثيقة بيانات وصفية (`metadata`) في `backups/{id}`، ومجموعة فرعية مجزأة `chunks/{chunkIndex}` لتفادي حد الـ 1MiB لوثيقة فايرستور.
* **حجم الـ Chunk:** كل جزء محدد بحد أقصى **900,000 بايت**.
* **الصلاحيات:**
  * **وثيقة البيانات الوصفية (Metadata Doc):** قراءة للمالك والأدمن، وإنشاء وتعديل وحذف للمالك باشتراك فعّال.
  * **أجزاء البيانات (Chunks Subcollection):** قراءة وكتابة وحذف **للمالك بالاشتراك الفعّال فقط**، والأدمن **بلا وصول** إليها حفاظاً على خصوصية بيانات المحل.
* **مثال وثيقة البيانات الوصفية (`backups/backup_2026-11-07_1200`):**
```json
{
  "id": "backup_2026-11-07_1200",
  "metadata": {
    "createdAt": "2026-11-07T18:00:00.000Z",
    "sizeBytes": 1780450,
    "appVersion": "1.0.0",
    "note": "نسخة تلقائية لنهاية الوردية",
    "totalInvoices": 142,
    "totalProducts": 48,
    "totalChunks": 2
  }
}
```
* **مثال وثيقة الجزء (`backups/backup_2026-11-07_1200/chunks/1`):**
```json
{
  "chunkIndex": 1,
  "data": "{\"products\":[...],\"customers\":[...]}",
  "createdAt": "2026-11-07T18:00:00.000Z"
}
```

---

### و) سجل وتدقيق التراخيص: `orgs/{orgId}/licenseEvents/{id}`
* **الغرض:** سجل غير قابل للتعديل يوثق كل عملية إصدار أو تجديد أو ترقية للترخيص الرقمي المشفر.
* **الصلاحيات:**
  * **قراءة:** المالك والأدمن.
  * **كتابة:** ممنوع منعاً باتاً من أي عميل (يُكتب حصراً عبر الخادم / Firebase Admin SDK).
* **مثال الوثيقة:**
```json
{
  "id": "event_lic_7712",
  "eventType": "issue",
  "targetDeviceId": "dev-eaed5535-c9c4",
  "branchId": "main-branch",
  "plan": "سوبر ماركت - باقة احترافية كاملة",
  "durationDays": 365,
  "previousValidUntil": null,
  "newValidUntil": "2027-11-07T16:06:06.000Z",
  "createdBy": "superadmin_uid",
  "createdAt": "2026-11-07T16:06:06.000Z",
  "notes": "ترخيص سنوي معتمد لجهاز الكاشير الرئيسي"
}
```

---

## 3. استعلامات لوحة التحكم المركزية (Collection Group Queries)

تستطيع لوحة تحكم السوبر أدمن استعراض مؤشرات كل الفروع والمحلات عبر الاستعلامات العامة دون معرفة مسار كل منظمة على حدة:

1. **استعلام الفروع المتصلة والنشطة عبر مصر:**
   ```typescript
   // Collection Group: 'branches'
   const q = query(
     collectionGroup(db, 'branches'),
     where('status', '==', 'active'),
     orderBy('lastSeenAt', 'desc'),
     limit(50)
   );
   ```

2. **استعلام إجمالي مبيعات اليوم على مستوى جميع المحلات المشتركة:**
   ```typescript
   // Collection Group: 'dailySummaries'
   const q = query(
     collectionGroup(db, 'dailySummaries'),
     where('__name__', '>=', '2026-11-07'),
     orderBy('updatedAt', 'desc')
   );
   ```

3. **استعلام الاشتراكات التي اقترب موعد انتهائها لاتخاذ إجراء التجديد:**
   ```typescript
   // Collection: 'orgs'
   const q = query(
     collection(db, 'orgs'),
     where('status', '==', 'active'),
     where('validUntil', '<=', thirtyDaysFromNow),
     orderBy('validUntil', 'asc')
   );
   ```

---

## 4. إرشادات النشر وتفعيل القواعد

* تم وضع تعليق تحذيري أعلى ملف `firestore.rules`:
  `// لا تُنشر قبل ربط التطبيق بالمخطط الجديد (الخطوة اللاحقة)`
* يتم تفعيل ونشر القواعد لاحقاً فور ربط دوال الرفع السحابي في `cloudService.ts` بالمخطط الجديد.
