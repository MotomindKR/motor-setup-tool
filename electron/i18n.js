'use strict';

const { createInstance } = require('i18next');
const options = require('./locales/options.json');
const korean = require('./locales/ko.json');

const i18n = createInstance();
i18n.init({ ...options, resources: { ko: { translation: korean } } });

module.exports = { i18n, t: i18n.t.bind(i18n) };
