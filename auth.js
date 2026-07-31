'use strict';
// ══════════════════════════════════════════════════════════════════
//  API TƏHLÜKƏSİZLİK QATI
// ══════════════════════════════════════════════════════════════════
//  /api/:fn dispatcher-i hər çağırışdan əvvəl bura müraciət edir.
//  Açar frontend-dən `X-CM-Key` başlığında gəlir (public/gsr-shim.js göndərir).
//
//  Səviyyələr:
//    'public' — açar tələb olunmur (PIN/kiosk/imtahan səhifəsi — bunların açarı yoxdur)
//    'self'   — funksiya ÖZ açarını/secret-ini arqument kimi yoxlayır → dispatcher qarışmır
//    'staff'  — istənilən etibarlı panel açarı (admin/menecer/trainer/icraçı/ops)
//    'admin'  — yalnız ADMIN_KEY
//
//  ⚠️ Siyahıda OLMAYAN funksiya avtomatik 'admin' sayılır (fail-closed).
//     Yeni API funksiyası yazanda bura da əlavə et, yoxsa yalnız admin çağıra biləcək.
// ══════════════════════════════════════════════════════════════════
const U = require('./utils');

const ADMIN_KEY = process.env.ADMIN_KEY || 'coffeemoon';

// AUTH_ENFORCE=true olana qədər dispatcher yalnız LOGLAYIR (davranış dəyişmir).
// Railway Variables-də açılır; problem çıxsa false-a qaytarmaq kifayətdir (deploy lazım deyil).
const AUTH_ENFORCE = process.env.AUTH_ENFORCE === 'true';

const API_POLICY = {
  // ── İşçilər
  getEmployees: 'admin',            // secret (login açarı) qaytarır → yalnız admin
  getEmployeesLite: 'public',       // secret-siz siyahı (/exam və trainer paneli üçün)
  addEmployee: 'admin', removeEmployee: 'admin',
  recalcAllStreaks: 'admin', recalcAllXP: 'admin', recalcAllFines: 'admin',
  updateEmployeeMessage: 'admin', getEmployeesByDept: 'admin',
  updateEmployeeDept: 'admin',      // filial dəyişmək — yalnız admin
  updateEmployeePosition: 'admin',  // vəzifə dəyişmək — yalnız admin
  getPositions: 'public',           // yalnız vəzifə adlarının siyahısı
  // Filial iş saatları: oxumaq panellərə lazımdır, dəyişmək yalnız admin
  getShiftConfig: 'staff', saveShiftConfig: 'admin', resetShiftConfig: 'admin',
  registerEmployeeSession: 'admin', // heç yerdən çağırılmır (ölü kod)

  // ── Cərimələr (admin)
  getFines: 'admin', updateFineStatus: 'admin', deleteFine: 'admin',

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
};

// Gələn açarı rola çevirir.
// İşçi secret-i burada TANINMIR — 'self' funksiyalar onu özləri yoxlayır (əlavə DB sorğusu olmasın).
function resolveRole(key) {
  if (!key) return null;
  if (key === ADMIN_KEY)                     return 'admin';
  if (key === U.getSetting('EXEC_KEY'))      return 'exec';
  if (key === U.getSetting('TRAINER_KEY'))   return 'trainer';
  if (key === U.getSetting('OPS_KEY'))       return 'ops';
  if (U.validateBranchScheduleKey(key).valid) return 'manager';
  return null;
}

// { ok, level, role } qaytarır. ok=false → icbari rejimdə 403, log-only rejimdə yalnız xəbərdarlıq.
function apiAccess(fn, key) {
  const level = API_POLICY[fn];
  if (level === 'public' || level === 'self') return { ok: true, level, role: null };
  const need = level || 'admin';              // siyahıda yoxdursa → admin (fail-closed)
  const role = resolveRole(key);
  if (need === 'admin') return { ok: role === 'admin', level: need, role };
  if (need === 'staff') return { ok: !!role,           level: need, role };
  return { ok: false, level: need, role };
}

module.exports = { API_POLICY, resolveRole, apiAccess, AUTH_ENFORCE, ADMIN_KEY };
