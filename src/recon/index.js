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
const cloudMetadataAuditor = require('./cloudMetadataAuditor');
const sqliTimingAuditor = require('./sqliTimingAuditor');
const massAssignmentAuditor = require('./massAssignmentAuditor');
const secondOrderAuditor = require('./secondOrderAuditor');
const openapiFuzzer = require('./openapiFuzzer');
const subdomainTakeoverAuditor = require('./subdomainTakeoverAuditor');
const jwtKeyConfusionAuditor = require('./jwtKeyConfusionAuditor');
const endpointHarvester = require('./endpointHarvester');

// Frontier Vectors
const httpSmugglingAuditor = require('./httpSmugglingAuditor');
const polyglotSstiAuditor = require('./polyglotSstiAuditor');
const prototypeGadgetAuditor = require('./prototypeGadgetAuditor');
const graphqlBatchAuditor = require('./graphqlBatchAuditor');
const cswshAuditor = require('./cswshAuditor');
const dependencyConfusionAuditor = require('./dependencyConfusionAuditor');
const webCacheAuditor = require('./webCacheAuditor');
const oauthPkceAuditor = require('./oauthPkceAuditor');


// Multi-Layer AppSec Pipelines
const bolaLifecyclePipeline = require('./bolaLifecyclePipeline');
const reachabilityProofPipeline = require('./reachabilityProofPipeline');
const blindDetectionPipeline = require('./blindDetectionPipeline');
const secondOrderPipeline = require('./secondOrderPipeline');

// 6 State-of-the-Art Recon Modules
const subdomainDiscovery = require('./subdomainDiscovery');
const techFingerprint = require('./techFingerprint');
const sensitiveFiles = require('./sensitiveFiles');
const bannerGrabber = require('./bannerGrabber');
const visualProof = require('./visualProof');
const tlsAuditor = require('./tlsAuditor');

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
  ...astReachability,
  ...cloudMetadataAuditor,
  ...sqliTimingAuditor,
  ...massAssignmentAuditor,
  ...secondOrderAuditor,
  ...openapiFuzzer,
  ...subdomainTakeoverAuditor,
  ...jwtKeyConfusionAuditor,
  ...endpointHarvester,
  ...httpSmugglingAuditor,
  ...polyglotSstiAuditor,
  ...prototypeGadgetAuditor,
  ...graphqlBatchAuditor,
  ...cswshAuditor,
  ...dependencyConfusionAuditor,
  ...webCacheAuditor,
  ...oauthPkceAuditor,
  ...bolaLifecyclePipeline,
  ...reachabilityProofPipeline,
  ...blindDetectionPipeline,
  ...secondOrderPipeline,
  ...subdomainDiscovery,
  ...techFingerprint,
  ...sensitiveFiles,
  ...bannerGrabber,
  ...visualProof,
  ...tlsAuditor
};