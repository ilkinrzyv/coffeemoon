/**
 * google.script.run uyğunluq qatı
 * Google Apps Script-dəki `google.script.run` çağırışlarını
 * Express API-yə /api/:functionName POST sorğularına çevirir.
 *
 * Orijinal istifadə:
 *   google.script.run.withSuccessHandler(cb).functionName(arg1, arg2)
 *   google.script.run.withSuccessHandler(cb).withFailureHandler(errCb).functionName(arg)
 *
 * Bu shim-lə dəyişməz qalır — heç bir HTML/JS dəyişikliyi lazım deyil.
 */
(function () {
  'use strict';

  // Səhifənin öz açarını tapır (hər panel açarını qlobal dəyişəndə saxlayır).
  // Çağırış anında oxunur — shim səhifə skriptlərindən ƏVVƏL yüklənir, ona görə
  // yükləmə anında bu dəyişənlər hələ mövcud olmur.
  // Tapılmasa URL-dəki ?key= / ?secret= ehtiyat yol kimi işlədilir.
  function pageKey() {
    // 1) Qlobal dəyişən (var ilə elan olunanlar window-a düşür)
    //    DEVICE_KEY — filial kiosku: onun "açarı" cihaz ID-sidir. Server bu
    //    ID-dən həm cihazı, həm də hansı müştəriyə aid olduğunu tanıyır.
    var names = ['ADMIN_KEY', 'BRANCH_KEY', 'TRAINER_KEY', 'EXEC_KEY', 'OPS_KEY', 'SECRET', 'DEVICE_KEY'];
    for (var i = 0; i < names.length; i++) {
      if (window[names[i]]) return String(window[names[i]]);
    }
    // 2) Ehtiyat: URL (hər panel öz açarı ilə açılır, PWA start_url-də də açar var)
    try {
      var q = new URLSearchParams(window.location.search);
      return q.get('key') || q.get('secret') || '';
    } catch (e) { return ''; }
  }

  // Açarsız səhifələr (kiosk, imtahan) hansı müştəriyə aid olduğunu bununla
  // bildirir. Server bunu YALNIZ açarsız ('public') funksiyalarda qəbul edir —
  // açardan gələn müştərini heç vaxt üstələyə bilmir.
  function pageTenant() {
    if (window.TENANT_HINT) return String(window.TENANT_HINT);
    try {
      var q = new URLSearchParams(window.location.search);
      return q.get('t') || '';
    } catch (e) { return ''; }
  }

  function createRunner(successCb, failureCb) {
    var runner = {
      withSuccessHandler: function (cb) {
        return createRunner(cb, failureCb);
      },
      withFailureHandler: function (cb) {
        return createRunner(successCb, cb);
      },
    };

    return new Proxy(runner, {
      get: function (target, prop) {
        if (prop in target) return target[prop];

        // prop = funksiya adı (məs. getEmployees, saveCedvel, ...)
        return function () {
          var args = Array.prototype.slice.call(arguments);
          var hdrs = { 'Content-Type': 'application/json' };
          var k = pageKey();
          if (k) hdrs['X-CM-Key'] = k;   // server rolu VƏ müştərini bu açardan tanıyır
          var t = pageTenant();
          if (t) hdrs['X-CM-Tenant'] = t;   // yalnız açarsız səhifələr üçün
          fetch('/api/' + prop, {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify({ args: args }),
          })
            .then(function (r) {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.json();
            })
            .then(function (data) {
              if (typeof successCb === 'function') successCb(data);
            })
            .catch(function (err) {
              if (typeof failureCb === 'function') {
                failureCb(err);
              } else {
                console.error('[GSR Shim]', prop, err);
              }
            });
        };
      },
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner(null, null);
})();
