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
          fetch('/api/' + prop, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
