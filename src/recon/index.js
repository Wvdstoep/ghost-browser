'use strict';
/**
 * ghost-browser/src/recon/index.js — Ghost Browser Security Intelligence & Recon Engine
 */

const advisory = require('./advisory');
const perimeter = require('./perimeter');
const sessionProbe = require('./sessionProbe');
const domAuditor = require('./domAuditor');
const redteam = require('./redteam');
const auditorSuite = require('./auditorSuite');
const accountAutomation = require('./accountAutomation');

module.exports = {
  ...advisory,
  ...perimeter,
  ...sessionProbe,
  ...domAuditor,
  ...redteam,
  ...auditorSuite,
  ...accountAutomation
};
