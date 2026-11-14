/**
 * إعدادات ربط Firebase الخاصة بمشروعك (من Firebase Console -> Project Settings -> Your apps)
 * استبدل قيم 'PUT_HERE' بالقيم الحقيقية من مشروعك.
 * عند ترك أي قيمة فارغة أو تساوي 'PUT_HERE'، يعتبر التطبيق السحابة "غير مُعدّة بعد"
 * ويعمل محلياً بالكامل بدون أي اتصال بـ Firebase.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
}

// [الصق هنا الـ firebaseConfig من Firebase Console بزرار النسخ]
export const firebaseConfig: FirebaseWebConfig = {
  apiKey: 'PUT_HERE',
  authDomain: 'PUT_HERE',
  projectId: 'PUT_HERE',
  storageBucket: 'PUT_HERE',
  messagingSenderId: 'PUT_HERE',
  appId: 'PUT_HERE',
};

export const firestoreDatabaseId = '(default)';

const REQUIRED_FIREBASE_KEYS: (keyof FirebaseWebConfig)[] = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

/**
 * يتحقق من اكتمال إعدادات Firebase.
 * إذا كانت أي قيمة مطلوبة فارغة أو 'PUT_HERE' (أو كانت أي قيمة في الكائن 'PUT_HERE')،
 * تُعتبر السحابة غير مُعدّة.
 */
export function isFirebaseConfigComplete(
  config: Partial<FirebaseWebConfig> | null | undefined = firebaseConfig,
  databaseId: string = firestoreDatabaseId
): boolean {
  if (!config || typeof config !== 'object') return false;
  if (!databaseId || databaseId.trim() === '' || databaseId.trim() === 'PUT_HERE') {
    return false;
  }

  for (const key of REQUIRED_FIREBASE_KEYS) {
    const val = config[key];
    if (typeof val !== 'string') return false;
    const trimmed = val.trim();
    if (trimmed === '' || trimmed === 'PUT_HERE') {
      return false;
    }
  }

  // إن وُجد measurementId بقيمة PUT_HERE يُعتبر الإعداد غير مكتمل
  if (typeof config.measurementId === 'string' && config.measurementId.trim() === 'PUT_HERE') {
    return false;
  }

  return true;
}
