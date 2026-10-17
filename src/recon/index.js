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
const headersAuditor = require('./headersAuditor');
const canaryAuditor = require('./canaryAuditor');
const semanticRouter = require('./semanticRouter');
const authMatrixAuditor = require('./authMatrixAuditor');
const patchGenerator = require('./patchGenerator');
const jwtAuditor = require('./jwtAuditor');
const throttlingAuditor = require('./throttlingAuditor');
const dualSessionAuditor = require('./dualSessionAuditor');
const graphqlAuditor = require('./graphqlAuditor');
const concurrencyAuditor = require('./concurrencyAuditor');
const complianceMapper = require('./complianceMapper');
const vibeSecurityAuditor = require('./vibeSecurityAuditor');
const cveVerifier = require('./cveVerifier');
const oastAuditor = require('./oastAuditor');
const astReachability = require('./astReachability');

module.exports = {
  ...advisory,
  ...perimeter,
  ...sessionProbe,
  ...domAuditor,
  ...redteam,
  ...auditorSuite,
  ...accountAutomation,
  ...headersAuditor,
  ...canaryAuditor,
  ...semanticRouter,
  ...authMatrixAuditor,
  ...patchGenerator,
  ...jwtAuditor,
  ...throttlingAuditor,
  ...dualSessionAuditor,
  ...graphqlAuditor,
  ...concurrencyAuditor,
  ...complianceMapper,
  ...vibeSecurityAuditor,
  ...cveVerifier,
  ...oastAuditor,
  ...astReachability
};
