/**
 * ترجمة أخطاء Firebase Auth و Cloud Firestore إلى رسائل عربية واضحة للمستخدم.
 */
export function translateFirebaseError(err: unknown): string {
  const errObj = (err && typeof err === 'object' ? err : {}) as {
    code?: unknown;
    message?: unknown;
  };

  const rawCode = typeof errObj.code === 'string' ? errObj.code.toLowerCase() : '';
  const rawMessage =
    typeof errObj.message === 'string'
      ? errObj.message
      : err instanceof Error
      ? err.message
      : String(err ?? '');
  const combined = `${rawCode} ${rawMessage.toLowerCase()}`;

  if (
    rawCode === 'auth/invalid-credential' ||
    rawCode === 'auth/wrong-password' ||
    rawCode === 'auth/invalid-email' ||
    combined.includes('auth/invalid-credential')
  ) {
    return 'بيانات الدخول غير صحيحة: يرجى التأكد من البريد الإلكتروني وكلمة المرور.';
  }

  if (rawCode === 'auth/user-not-found' || combined.includes('auth/user-not-found')) {
    return 'لم يتم العثور على حساب مسجّل بهذا البريد الإلكتروني على السحابة.';
  }

  if (rawCode === 'auth/too-many-requests' || combined.includes('auth/too-many-requests')) {
    return 'تم حظر المحاولات مؤقتاً بسبب كثرة المحاولات الفاشلة. يرجى الانتظار قليلاً ثم المحاولة مرة أخرى.';
  }

  if (rawCode === 'auth/user-disabled' || combined.includes('auth/user-disabled')) {
    return 'تم إيقاف هذا الحساب من لوحة إدارة السحابة. يرجى التواصل مع الدعم الفني.';
  }

  if (
    rawCode === 'permission-denied' ||
    rawCode === 'firestore/permission-denied' ||
    combined.includes('permission-denied') ||
    combined.includes('missing or insufficient permissions')
  ) {
    return 'تم رفض الصلاحية من السحابة: السبب غالباً توقف/انتهاء الاشتراك أو عدم إنشاء سجل المحل والفرع على السحابة.';
  }

  if (
    rawCode === 'not-found' ||
    rawCode === 'firestore/not-found' ||
    combined.includes('not-found') ||
    combined.includes('no document to update')
  ) {
    return 'لم يتم العثور على سجل المحل أو الفرع على السحابة: تأكد من إنشاء الفرع في قاعدة البيانات ومطابقة معرّفات الترخيص.';
  }

  if (
    rawCode === 'unavailable' ||
    rawCode === 'firestore/unavailable' ||
    rawCode === 'auth/network-request-failed' ||
    combined.includes('unavailable') ||
    combined.includes('network-request-failed') ||
    combined.includes('the client is offline') ||
    combined.includes('failed to get document because the client is offline')
  ) {
    return 'السحابة غير متاحة حالياً أو تعذر الاتصال بالإنترنت. يستمر النظام بالعمل محلياً وسيتم التزامن عند توفر الشبكة.';
  }

  if (rawMessage && rawMessage.trim()) {
    return `تعذر إتمام العملية السحابية: ${rawMessage}`;
  }

  return 'حدث خطأ غير متوقع أثناء الاتصال بالسحابة. يرجى المحاولة مرة أخرى.';
}
