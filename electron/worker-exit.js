'use strict';

const { t } = require('./i18n');

function exitError(name, code, signal, stderr) {
  const detail = stderr.trim();
  if (signal) return new Error(t("{{name}} terminated by {{signal}}{{detail}}", { name, signal, detail: detail ? `\n${detail}` : '' }));
  return new Error(detail || t("{{name}} exited with status {{code}}", { name, code }));
}

module.exports = { exitError };
