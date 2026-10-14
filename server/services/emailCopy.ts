// Email wording in the three supported languages. Placeholders use {name} syntax.
export type Lang = 'fr' | 'ar' | 'en';
export const isLang = (v: unknown): v is Lang => v === 'fr' || v === 'ar' || v === 'en';
export const LOCALE: Record<Lang, string> = { fr: 'fr-FR', ar: 'ar-TN', en: 'en-GB' };

export const fill = (s: string, vars: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

interface Copy {
  at: string;
  labels: { reference: string; service: string; barber: string; when: string; duration: string; price: string; where: string };
  pay: Record<string, string>;
  duration: (min: number) => string;
  policy: string;
  manageButton: string;
  manageText: string;
  dashboardButton: string;
  reason: string;
  noPhone: string;
  noEmail: string;
  awaitingApproval: string;
  kinds: Record<'confirmation' | 'pending' | 'approved' | 'rescheduled' | 'cancelled' | 'reminder' | 'owner_new', { subject: string; heading: string; intro: string }>;
  code: { verifyHeading: string; bookingHeading: string; verifyIntro: string; bookingIntro: string; expires: string; subject: string; codeLabel: string };
  link: { inviteHeading: string; resetHeading: string; inviteIntro: string; resetIntro: string; inviteButton: string; resetButton: string; inviteSubject: string; resetSubject: string };
}

const hm = (min: number, h: string, m: string) => {
  const hours = Math.floor(min / 60), rest = min % 60;
  return hours ? (rest ? `${hours} ${h} ${rest} ${m}` : `${hours} ${h}`) : `${min} ${m}`;
};

export const COPY: Record<Lang, Copy> = {
  en: {
    at: 'at',
    labels: { reference: 'Reference', service: 'Service', barber: 'Barber', when: 'When', duration: 'Duration', price: 'Price', where: 'Where' },
    pay: { unpaid: 'To pay at the shop', partial: 'Partially paid', paid: 'Paid', refund_due: 'Refund due' },
    duration: (min) => hm(min, 'h', 'min'),
    policy: 'You can cancel up to {cancel} h and reschedule up to {reschedule} h before your appointment. After that, please call us on {phone}.',
    manageButton: 'View or manage booking',
    manageText: 'Manage your booking:',
    dashboardButton: 'Open in dashboard',
    reason: 'Reason: {reason}.',
    noPhone: 'no phone', noEmail: 'no email',
    awaitingApproval: 'This booking is waiting for your approval.',
    kinds: {
      confirmation: { subject: 'Booking confirmed — {when} ({ref})', heading: 'Your chair is reserved.', intro: 'Hi {name}, your appointment is confirmed. We look forward to seeing you.' },
      pending: { subject: 'Booking request received ({ref})', heading: 'We have your request.', intro: 'Hi {name}, your booking request has been received and is awaiting confirmation by the shop. We will email you as soon as it is approved.' },
      approved: { subject: 'Booking approved — {when} ({ref})', heading: 'Your booking is approved.', intro: 'Hi {name}, good news: the shop has confirmed your appointment.' },
      rescheduled: { subject: 'Appointment moved — now {when} ({ref})', heading: 'Your appointment has moved.', intro: 'Hi {name}, your appointment has been rescheduled. The new details are below.' },
      cancelled: { subject: 'Appointment cancelled ({ref})', heading: 'Your appointment is cancelled.', intro: 'Hi {name}, your appointment below has been cancelled.{reason} You are welcome to book another time whenever suits you.' },
      reminder: { subject: 'Reminder — {when} at {shop}', heading: 'See you soon.', intro: 'Hi {name}, a quick reminder of your upcoming appointment.' },
      owner_new: { subject: 'New booking: {name}, {when}', heading: 'New online booking.', intro: '{name} ({phone}, {email}) just booked online.{approval}' },
    },
    code: {
      verifyHeading: 'Confirm your email.', bookingHeading: 'Confirm your booking.',
      verifyIntro: 'Use this code to finish creating your {shop} account.', bookingIntro: 'Use this code to confirm your booking at {shop}.',
      expires: 'The code expires in 15 minutes. If you did not request it, you can ignore this email.', subject: '{code} is your {shop} code', codeLabel: 'Code',
    },
    link: {
      inviteHeading: 'Welcome to the {shop} team.', resetHeading: 'Reset your password.',
      inviteIntro: 'Hi {name}, an account has been created for you. Choose a password to access your schedule.',
      resetIntro: 'Hi {name}, use the button below to choose a new password. The link is valid for 2 hours.',
      inviteButton: 'Set my password', resetButton: 'Choose a new password', inviteSubject: 'Your {shop} staff account', resetSubject: 'Reset your {shop} password',
    },
  },
  fr: {
    at: 'à',
    labels: { reference: 'Référence', service: 'Service', barber: 'Coiffeur', when: 'Quand', duration: 'Durée', price: 'Prix', where: 'Où' },
    pay: { unpaid: 'À régler au salon', partial: 'Payé en partie', paid: 'Payé', refund_due: 'À rembourser' },
    duration: (min) => hm(min, 'h', 'min'),
    policy: 'Vous pouvez annuler jusqu’à {cancel} h et déplacer votre rendez-vous jusqu’à {reschedule} h avant. Passé ce délai, appelez-nous au {phone}.',
    manageButton: 'Voir ou gérer la réservation',
    manageText: 'Gérer votre réservation :',
    dashboardButton: 'Ouvrir dans le tableau de bord',
    reason: 'Motif : {reason}.',
    noPhone: 'pas de téléphone', noEmail: 'pas d’e-mail',
    awaitingApproval: 'Cette réservation attend votre validation.',
    kinds: {
      confirmation: { subject: 'Réservation confirmée — {when} ({ref})', heading: 'Votre fauteuil est réservé.', intro: 'Bonjour {name}, votre rendez-vous est confirmé. Nous avons hâte de vous recevoir.' },
      pending: { subject: 'Demande de réservation reçue ({ref})', heading: 'Votre demande est enregistrée.', intro: 'Bonjour {name}, nous avons bien reçu votre demande ; elle attend la confirmation du salon. Vous recevrez un e-mail dès sa validation.' },
      approved: { subject: 'Réservation validée — {when} ({ref})', heading: 'Votre réservation est validée.', intro: 'Bonjour {name}, bonne nouvelle : le salon a confirmé votre rendez-vous.' },
      rescheduled: { subject: 'Rendez-vous déplacé — désormais {when} ({ref})', heading: 'Votre rendez-vous a été déplacé.', intro: 'Bonjour {name}, votre rendez-vous a été reprogrammé. Voici les nouvelles informations.' },
      cancelled: { subject: 'Rendez-vous annulé ({ref})', heading: 'Votre rendez-vous est annulé.', intro: 'Bonjour {name}, le rendez-vous ci-dessous a été annulé.{reason} Vous pouvez réserver un autre créneau quand vous le souhaitez.' },
      reminder: { subject: 'Rappel — {when} chez {shop}', heading: 'À très bientôt.', intro: 'Bonjour {name}, un petit rappel de votre prochain rendez-vous.' },
      owner_new: { subject: 'Nouvelle réservation : {name}, {when}', heading: 'Nouvelle réservation en ligne.', intro: '{name} ({phone}, {email}) vient de réserver en ligne.{approval}' },
    },
    code: {
      verifyHeading: 'Confirmez votre e-mail.', bookingHeading: 'Confirmez votre réservation.',
      verifyIntro: 'Utilisez ce code pour terminer la création de votre compte {shop}.', bookingIntro: 'Utilisez ce code pour confirmer votre réservation chez {shop}.',
      expires: 'Ce code expire dans 15 minutes. Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.', subject: '{code} est votre code {shop}', codeLabel: 'Code',
    },
    link: {
      inviteHeading: 'Bienvenue dans l’équipe {shop}.', resetHeading: 'Réinitialisez votre mot de passe.',
      inviteIntro: 'Bonjour {name}, un compte a été créé pour vous. Choisissez un mot de passe pour accéder à votre planning.',
      resetIntro: 'Bonjour {name}, utilisez le bouton ci-dessous pour choisir un nouveau mot de passe. Le lien est valable 2 heures.',
      inviteButton: 'Choisir mon mot de passe', resetButton: 'Choisir un nouveau mot de passe', inviteSubject: 'Votre compte équipe {shop}', resetSubject: 'Réinitialiser votre mot de passe {shop}',
    },
  },
  ar: {
    at: 'على الساعة',
    labels: { reference: 'المرجع', service: 'الخدمة', barber: 'الحلاق', when: 'الموعد', duration: 'المدة', price: 'السعر', where: 'المكان' },
    pay: { unpaid: 'الدفع في الصالون', partial: 'مدفوع جزئيًا', paid: 'مدفوع', refund_due: 'يستحق الاسترجاع' },
    duration: (min) => hm(min, 'س', 'د'),
    policy: 'يمكنك الإلغاء حتى {cancel} ساعة وتغيير الموعد حتى {reschedule} ساعة قبل موعدك. بعد ذلك، اتصل بنا على {phone}.',
    manageButton: 'عرض أو إدارة الحجز',
    manageText: 'إدارة حجزك:',
    dashboardButton: 'فتح في لوحة التحكم',
    reason: 'السبب: {reason}.',
    noPhone: 'بدون هاتف', noEmail: 'بدون بريد',
    awaitingApproval: 'هذا الحجز في انتظار موافقتك.',
    kinds: {
      confirmation: { subject: 'تم تأكيد الحجز — {when} ({ref})', heading: 'كرسيك محجوز.', intro: 'مرحبًا {name}، تم تأكيد موعدك. نتطلع لرؤيتك.' },
      pending: { subject: 'تم استلام طلب الحجز ({ref})', heading: 'استلمنا طلبك.', intro: 'مرحبًا {name}، استلمنا طلب حجزك وهو في انتظار تأكيد الصالون. سنراسلك فور الموافقة عليه.' },
      approved: { subject: 'تمت الموافقة على الحجز — {when} ({ref})', heading: 'تمت الموافقة على حجزك.', intro: 'مرحبًا {name}، خبر سار: أكّد الصالون موعدك.' },
      rescheduled: { subject: 'تم تغيير الموعد — الآن {when} ({ref})', heading: 'تم تغيير موعدك.', intro: 'مرحبًا {name}، تمت إعادة جدولة موعدك. التفاصيل الجديدة أدناه.' },
      cancelled: { subject: 'تم إلغاء الموعد ({ref})', heading: 'تم إلغاء موعدك.', intro: 'مرحبًا {name}، تم إلغاء الموعد أدناه.{reason} يمكنك حجز وقت آخر متى شئت.' },
      reminder: { subject: 'تذكير — {when} في {shop}', heading: 'نراك قريبًا.', intro: 'مرحبًا {name}، تذكير سريع بموعدك القادم.' },
      owner_new: { subject: 'حجز جديد: {name}، {when}', heading: 'حجز جديد عبر الإنترنت.', intro: '{name} ({phone}، {email}) حجز للتو عبر الإنترنت.{approval}' },
    },
    code: {
      verifyHeading: 'أكّد بريدك الإلكتروني.', bookingHeading: 'أكّد حجزك.',
      verifyIntro: 'استعمل هذا الرمز لإتمام إنشاء حسابك في {shop}.', bookingIntro: 'استعمل هذا الرمز لتأكيد حجزك في {shop}.',
      expires: 'تنتهي صلاحية الرمز بعد 15 دقيقة. إن لم تطلبه، تجاهل هذه الرسالة.', subject: '{code} هو رمزك في {shop}', codeLabel: 'الرمز',
    },
    link: {
      inviteHeading: 'مرحبًا بك في فريق {shop}.', resetHeading: 'إعادة تعيين كلمة المرور.',
      inviteIntro: 'مرحبًا {name}، تم إنشاء حساب لك. اختر كلمة مرور للوصول إلى جدولك.',
      resetIntro: 'مرحبًا {name}، استعمل الزر أدناه لاختيار كلمة مرور جديدة. الرابط صالح لمدة ساعتين.',
      inviteButton: 'اختيار كلمة المرور', resetButton: 'اختيار كلمة مرور جديدة', inviteSubject: 'حسابك في فريق {shop}', resetSubject: 'إعادة تعيين كلمة مرورك في {shop}',
    },
  },
};
