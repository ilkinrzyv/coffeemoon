-- ══════════════════════════════════════════════════════════════
--  Performans indeksləri
--  Supabase SQL Editor-də işlət (data silmir, təkrar işlətmək olar)
--  Məqsəd: tez-tez sorğulanan sütunlarda tam cədvəl skanını aradan qaldırmaq
-- ══════════════════════════════════════════════════════════════

-- attendance — ən çox sorğulanan cədvəl (calcStreak, gəliş/çıxış, hesabat)
CREATE INDEX IF NOT EXISTS idx_attendance_emp_type_ts ON attendance (emp_id, type, timestamp);
CREATE INDEX IF NOT EXISTS idx_attendance_ts          ON attendance (timestamp);

-- cedvel — getEmployeeShift hər streak hesablamasında çağırır
CREATE INDEX IF NOT EXISTS idx_cedvel_emp_date  ON cedvel (emp_id, date_str);
CREATE INDEX IF NOT EXISTS idx_cedvel_dept_date ON cedvel (dept, date_str);

-- nahar
CREATE INDEX IF NOT EXISTS idx_nahar_emp ON nahar (emp_id);

-- izin / late_perms (icazə yoxlamaları)
CREATE INDEX IF NOT EXISTS idx_izin_emp_status     ON izin (emp_id, status);
CREATE INDEX IF NOT EXISTS idx_lateperms_emp_date  ON late_perms (emp_id, date_str);
CREATE INDEX IF NOT EXISTS idx_lateperms_status    ON late_perms (status);

-- avans / product_logs / checklist_logs / mgr_schedule
CREATE INDEX IF NOT EXISTS idx_avans_emp_date       ON avans (emp_id, date_str);
CREATE INDEX IF NOT EXISTS idx_productlogs_dept_date ON product_logs (dept, date_str);
CREATE INDEX IF NOT EXISTS idx_checklog_date_dept    ON checklist_logs (date, dept);
CREATE INDEX IF NOT EXISTS idx_mgrsched_dept_date    ON mgr_schedule (dept, date_str);
