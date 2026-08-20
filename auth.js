'use strict';
// ══════════════════════════════════════════════════════════════════
//  API TƏHLÜKƏSİZLİK QATI
// ══════════════════════════════════════════════════════════════════
//  /api/:fn dispatcher-i hər çağırışdan əvvəl bura müraciət edir.
//  Açar frontend-dən `X-CM-Key` başlığında gəlir (public/gsr-shim.js göndərir).
//
//  Səviyyələr:
//    'public'   — açar tələb olunmur (PIN/kiosk/imtahan səhifəsi — bunların açarı yoxdur)
//    'self'     — funksiya ÖZ açarını/secret-ini arqument kimi yoxlayır → dispatcher qarışmır
//    'staff'    — istənilən etibarlı panel açarı (admin/menecer/trainer/icraçı/ops)
//    'admin'    — yalnız həmin MÜŞTƏRİNİN admin açarı
//    'platform' — yalnız platforma sahibi (PLATFORM_KEY) — müştərilərin üstündə
//
//  ⚠️ Siyahıda OLMAYAN funksiya avtomatik 'admin' sayılır (fail-closed).
//     Yeni API funksiyası yazanda bura da əlavə et, yoxsa yalnız admin çağıra biləcək.
//
//  ÇOX-MÜŞTƏRİLİ QEYD
//  ──────────────────
//  Rol həlli artıq `tenant.js`-dədir: açar `auth_keys` cədvəlindən HƏM rolu,
//  HƏM də hansı müştəriyə aid olduğunu qaytarır. Bu fayl yalnız "bu rol bu
//  funksiyanı çağıra bilərmi?" sualına cavab verir. Müştəri izolyasiyası ayrıca
//  qatdadır (`tdb.js`) — yəni rol yoxlaması səhv olsa belə bir müştəri
//  başqasının datasını GÖRƏ BİLMİR.
// ══════════════════════════════════════════════════════════════════

// Rol yoxlamasını yumşaltmaq üçün ehtiyat qapı (yalnız rol — izolyasiya YOX).
// Defolt: icbari. Problem çıxsa Railway Variables-də AUTH_ENFORCE=false et.
const AUTH_ENFORCE = process.env.AUTH_ENFORCE !== 'false';

const API_POLICY = {
  // ── İşçilər
  getEmployees: 'admin',            // secret (login açarı) qaytarır → yalnız admin
  getEmployeesLite: 'public',       // secret-siz siyahı (/exam və trainer paneli üçün)
  addEmployee: 'admin', removeEmployee: 'admin',
  recalcAllStreaks: 'admin', recalcAllXP: 'admin', recalcAllFines: 'admin',
  updateEmployeeMessage: 'admin', getEmployeesByDept: 'admin',
  updateEmployeeDept: 'admin',      // filial dəyişmək — yalnız admin
  updateEmployeePosition: 'admin',  // vəzifə dəyişmək — yalnız admin
  updateEmployeeTaxiLimit: 'admin', // aylıq taksi limiti — yalnız admin
  getPositions: 'public',           // yalnız vəzifə adlarının siyahısı
  // Filial iş saatları: oxumaq panellərə lazımdır, dəyişmək yalnız admin
  getShiftConfig: 'staff', saveShiftConfig: 'admin', resetShiftConfig: 'admin',
  registerEmployeeSession: 'admin', // heç yerdən çağırılmır (ölü kod)

  // ── Açıq (bağlanmamış) smenlər — girişi bloklayır, təsdiq admindədir
  getOpenShifts: 'admin', closeOpenShift: 'admin', closeAllOpenShifts: 'admin',

  // ── Cərimələr (admin)
  getFines: 'admin', updateFineStatus: 'admin', deleteFine: 'admin',
  // Silmək və ödəniş statusunu dəyişmək maaş tutulmasına təsir edir → yalnız admin
  deleteAnyFine: 'admin', setFinePayStatus: 'admin',
  liftTohmet: 'admin',              // AR ƏM 190 — tənbehi vaxtından əvvəl götürmək

  // ── Konfiqurasiyalar (əvvəl kodda hardcode idi)
  // Oxumaq: intizam/XP qaydalarını işçi paneli də göstərə bilsin deyə `staff`.
  // Yazmaq: hamısı yalnız admin — bunlar cərimə məbləğinə və XP-yə təsir edir.
  getDisciplineConfig: 'staff',  saveDisciplineConfig: 'admin', resetDisciplineConfig: 'admin',
  getXPConfig: 'staff',          saveXPConfig: 'admin',         resetXPConfig: 'admin',
  // Telegram şablonları mesaj mətnidir — oxumaq da yalnız admin
  getTgTemplates: 'admin', saveTgTemplates: 'admin', resetTgTemplates: 'admin',
  previewTgTemplate: 'admin',
  getPushTemplates: 'admin', savePushTemplates: 'admin', resetPushTemplates: 'admin',
  previewPushTemplate: 'admin',

  // ── Cihazlar
  bindDevice: 'self', resetDevice: 'admin',
  checkScanDevice: 'public',        // filial kiosk cihazı — açarı yoxdur
  getScanDevices: 'admin', approveScanDevice: 'admin',
  blockScanDevice: 'admin', removeScanDevice: 'admin',

  // ── Cədvəl
  getCedvel: 'staff', saveCedvel: 'admin',
  getDeptList: 'public',            // yalnız filial adları
  getBranchScheduleKeys: 'admin',   // BÜTÜN menecer açarlarını qaytarır
  validateBranchScheduleKey: 'public',
  getCedvelForTrainer: 'self', getCedvelForManager: 'self', saveCedvelForManager: 'self',

  // ── İzin
  getIzinList: 'admin', addIzin: 'admin', updateIzinStatus: 'admin', removeIzin: 'admin',

  // ── Hesabat
  getMonthlyReport: 'staff', getWarnings: 'staff',
  // Maaş — HAMISI admin. Hesabat bütün filialların maaşını, cərimə səbəblərini və
  // avanslarını qaytarır; 'staff' olsaydı bir filialın menecer açarı ilə hamısını
  // çəkmək olardı. Yeganə çağıran admin.html-dir (açarı ADMIN_KEY-dir) → panel eyni işləyir.
  getSalaryReport: 'admin', getSalaryConfig: 'admin',
  saveSalaryConfig: 'admin', resetSalaryConfig: 'admin',
  // Ayın bağlanması — ödənilmiş ayın rəqəmlərini dondurur/açır
  closeSalaryMonth: 'admin', reopenSalaryMonth: 'admin', getClosedSalaryMonths: 'admin',
  getOnlineEmployees: 'staff', getManagersLiveStatus: 'staff',

  // ── Davamiyyət
  validateAndLog: 'public',         // PIN-in özü credential-dır
  logLunch: 'self', getLunchLogForManager: 'self', logManagerCheckin: 'self',
  getDashboardData: 'self',

  // ── Push abunəlik (hamısı öz açarını yoxlayır)
  subscribePush: 'self', unsubscribePush: 'self',
  subscribePushManager: 'self', unsubscribePushManager: 'self',
  subscribePushExec: 'self', unsubscribePushExec: 'self',
  subscribePushTrainer: 'self', unsubscribePushTrainer: 'self',

  // ── Menecer info / icraçı mesajı
  getMgrInfo: 'staff', saveMgrInfo: 'admin',
  saveExecMessages: 'self', getMgrInfoForBranch: 'self',

  // ── Telegram / WiFi IP (bot tokeni və şəbəkə qoruması)
  getTelegramSettings: 'admin', saveTelegramSettings: 'admin', testTelegram: 'admin',
  getBranchIPs: 'admin', saveBranchIPs: 'admin',

  // ── Çeklist
  getChecklistItems: 'admin', saveChecklistItems: 'admin', saveAdminNote: 'admin',
  getChecklistForBranch: 'self', submitChecklistItem: 'self',
  getChecklistReport: 'staff', getMgrAcksForAdmin: 'staff',
  getMgrAckStatus: 'self', ackMgrMessage: 'self',

  // ── Məhsullar
  getProducts: 'admin', addProduct: 'admin', deleteProduct: 'admin',
  getProductLogsForBranch: 'self', saveProductLogs: 'self',
  getWasteStatsForAdmin: 'staff',

  // ── Menecer qrafiki
  getMgrWeekSchedule: 'self', saveMgrWeekSchedule: 'self',
  getMgrScheduleForAdmin: 'staff',

  // ── Gec gəliş icazəsi
  requestLatePerm: 'self', getLatePermsForManager: 'self',
  getLatePermsForExec: 'self', approveLatePerm: 'self', getMyLatePerms: 'self',

  // ── Avans
  requestAvans: 'self', getMyAvansList: 'self', getAvansForManager: 'self',
  getAvansList: 'admin', getApprovedByBranch: 'admin',
  updateAvansStatus: 'staff',       // manager.html açarsız çağırır → ən azı panel açarı tələb olunur

  // ── Cərimə (menecer)
  addMgrFine: 'self', getMgrFinesForManager: 'self',
  getFineCapacity: 'self',           // menecer cərimə yazmazdan əvvəl qalan tavanı görür
  getMgrFinesForAdmin: 'staff',
  getMyFines: 'self', acknowledgeFine: 'self',

  // ── Elanlar
  getAnnouncements: 'admin',        // işçi bunları getDashboardData-dan alır
  saveAnnouncement: 'admin', deleteAnnouncement: 'admin',

  // ── Profil / sosial (hamısı secret ilə)
  getMyProfile: 'self', saveProfile: 'self', getTeamProfiles: 'self',
  getReactions: 'self', toggleReaction: 'self', getPublicProfile: 'self',
  sendEmergency: 'self',

  // ── Menecer dashboard
  getManagerDashboard: 'self',

  // ── Rol açarları (açarı QAYTARAN/DƏYİŞƏN funksiyalar — mütləq admin)
  getTrainerKey: 'admin', regenerateTrainerKey: 'admin', setTrainerName: 'admin',
  getExecKey: 'admin', regenerateExecKey: 'admin', setExecName: 'admin',
  getOpsKey: 'admin', regenerateOpsKey: 'admin', setOpsName: 'admin',

  // ── Ops paneli (hamısı opsAuth ilə)
  getOpsBootstrap: 'self', getOpsCategories: 'self', saveOpsCategories: 'self',
  saveOpsVisit: 'self', getOpsMeetingData: 'self', getOpsBranchDetail: 'self',
  getOpsIssues: 'self', updateOpsIssue: 'self',
  uploadOpsPhoto: 'self',

  // ── Trainer
  getAllTrainerItems: 'admin', saveTrainerItems: 'admin',
  getActiveTrainerItems: 'staff', getTrainerMaterials: 'staff',
  getTrainerLogs: 'staff', getExamLogs: 'staff', getXPAuditLog: 'admin',
  submitTrainerLog: 'self', getTodayTrainerLogs: 'self',
  submitExam: 'self', giveManualXP: 'self', rateEmployee: 'self',
  gradeOpenAnswer: 'self', getTodayExams: 'self', getExamResultsByDate: 'self',
  saveTrainerMaterial: 'self', deleteTrainerMaterial: 'self',

  // ── İmtahan sualları
  getExamQuestions: 'staff',        // DÜZGÜN CAVABLARI da qaytarır → açıq qalmamalıdır
  saveExamQuestion: 'self', deleteExamQuestion: 'self',

  // ── İşçi özü imtahanı (/exam səhifəsinin açarı yoxdur)
  getExamStatus: 'public', setExamStatus: 'self',
  getExamQuestionsPublic: 'public', submitEmployeeExam: 'public',

  // ── FİLİALLAR (Faza 1) — filial artıq datadır, kod deyil
  getBranches: 'staff',
  addBranch: 'admin', updateBranch: 'admin',
  renameBranch: 'admin', deleteBranch: 'admin', reorderBranches: 'admin',

  // ── VƏZİFƏLƏR — hər müştəri özü təyin edir
  savePositions: 'admin',

  // ── MÜŞTƏRİ ÖZÜ HAQQINDA (brend, abunəlik vəziyyəti)
  getTenantInfo: 'staff',
  saveTenantBrand: 'admin',
  getAdminKey: 'admin', regenerateAdminKey: 'admin',

  // ── PLATFORMA (yalnız PLATFORM_KEY — bütün müştərilərin üstündə)
  platformListTenants: 'platform',
  platformCreateTenant: 'platform',
  platformUpdateTenant: 'platform',
  platformDeleteTenant: 'platform',
  platformTenantKeys: 'platform',
  platformStats: 'platform',
};

// Rollar səviyyələrə görə qruplaşdırılır.
const STAFF_ROLES = new Set(['admin', 'manager', 'exec', 'trainer', 'ops']);

// `authRec` — tenant.resolveKey(...) nəticəsi: { tenantId, role, branchId } | null
// Rol həlli artıq burada EDİLMİR: dispatcher onu bir dəfə edir və həm tenant
// kontekstini qurmaq, həm də bu yoxlama üçün eyni nəticəni işlədir.
function apiAccess(fn, authRec) {
  const level = API_POLICY[fn];
  const role  = (authRec && authRec.role) || null;

  if (level === 'platform') return { ok: role === 'platform', level, role };

  // Platforma açarı müştəri API-lərini çağıra bilməz — onun tenant konteksti yoxdur.
  // (Dəstək üçün müştəri adından iş görmək lazım olsa, ayrıca "impersonate" axını yazılmalıdır.)
  if (level === 'public' || level === 'self') return { ok: true, level, role };

  const need = level || 'admin';              // siyahıda yoxdursa → admin (fail-closed)
  if (need === 'admin') return { ok: role === 'admin',      level: need, role };
  if (need === 'staff') return { ok: STAFF_ROLES.has(role), level: need, role };
  return { ok: false, level: need, role };
}

module.exports = { API_POLICY, apiAccess, AUTH_ENFORCE, STAFF_ROLES };
