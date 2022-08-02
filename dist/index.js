/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 33:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

const core = __nccwpck_require__(927);
const github = __nccwpck_require__(273);
const { Octokit } = __nccwpck_require__(819);
const { retry } = __nccwpck_require__(585);
const RetryingOctokit = Octokit.plugin(retry);
const { parseTestReports } = __nccwpck_require__(53);

const action = async () => {
    const reportPaths = core.getInput('report_paths').split(',').join('\n');
    core.info(`Going to parse results form ${reportPaths}`);
    const githubToken = core.getInput('github_token');
    const createCheck = (core.getInput('create_check') || 'true') === 'true';
    const name = core.getInput('check_name');
    const commit = core.getInput('commit');
    const failOnFailedTests = core.getInput('fail_on_test_failures') === 'true';
    const failIfNoTests = core.getInput('fail_if_no_tests') === 'true';
    const skipPublishing = core.getInput('skip_publishing') === 'true';

    core.info("HERE2 1");

    let { count, skipped, annotations } = await parseTestReports(reportPaths);
    core.info("HERE2 2");
    const foundResults = count > 0 || skipped > 0;
    const conclusion =
        (foundResults && annotations.length === 0) || (!foundResults && !failIfNoTests)
            ? 'success'
            : 'failure';
    core.info("HERE2 3");
    if (!skipPublishing) {
        const title = foundResults
            ? `${count} tests run, ${skipped} skipped, ${annotations.length} failed.`
            : 'No test results found!';
        core.info("HERE 1");
        core.info(`Result: ${title}`);
        core.info("HERE 2");
        const pullRequest = github.context.payload.pull_request;
        core.info("HERE 3");
        const link = (pullRequest && pullRequest.html_url) || github.context.ref;
        core.info("HERE 4");
        const status = 'completed';
        core.info("HERE 5");
        const head_sha = commit || (pullRequest && pullRequest.head.sha) || github.context.sha;
        core.info("HERE 6");
        core.info("TOKEN " + githubToken);
        const octokit = new RetryingOctokit({auth: githubToken, request: { retries: 3 }});
        core.info("HERE 7");
        if (createCheck) {
            core.info(`Posting status '${status}' with conclusion '${conclusion}' to ${link} (sha: ${head_sha})`);
            const createCheckRequest = {
                ...github.context.repo,
                name,
                head_sha,
                status,
                conclusion,
                output: {
                    title,
                    summary: '',
                    annotations: annotations.slice(0, 50)
                }
            };

            core.debug(JSON.stringify(createCheckRequest, null, 2));

            await octokit.rest.checks.create(createCheckRequest);
        } else {
            const { data: {check_runs: check_runs} } = await octokit.rest.checks.listForRef({
                ...github.context.repo,
                check_name: name,
                ref: head_sha,
                status: 'in_progress'
            })
            core.debug(JSON.stringify(check_runs, null, 2));
            if (check_runs.length == 0) {
                core.setFailed(`Did not find any in progress '${name}' check for sha ${head_sha}`);
                return;
            }
            if (check_runs.length != 1) {
                core.setFailed(`Found multiple in progress '${name}' checks for sha ${head_sha}`);
                return;
            }
            const check_run = check_runs[0];
            core.info(`Patching '${name}' check for ${link} (sha: ${head_sha})`);
            const updateCheckRequest = {
                ...github.context.repo,
                check_run_id: check_run.id,
                output: {
                    title: check_run.output.title || title,
                    summary: check_run.output.summary || '',
                    annotations: annotations.slice(0, 50)
                }
            };

            core.debug(JSON.stringify(updateCheckRequest, null, 2));

            await octokit.rest.checks.update(updateCheckRequest);
        }
    } else {
        core.info('Not publishing test result due to skip_publishing=true');
    }

    // make conclusion consumable by downstream actions
    core.setOutput('conclusion', conclusion);

    // optionally fail the action if tests fail
    if (failOnFailedTests && conclusion !== 'success') {
        core.setFailed(`There were ${annotations.length} failed tests`);
    }
};

module.exports = action;


/***/ }),

/***/ 53:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

const glob = __nccwpck_require__(837);
const core = __nccwpck_require__(927);
const fs = __nccwpck_require__(147);
const parser = __nccwpck_require__(572);

const resolveFileAndLine = (file, classname, output) => {
    // extract filename from classname and remove suffix
    const filename = file ? file : classname.split('.').slice(-1)[0].split('(')[0];
    const matches = output.match(new RegExp(`${filename}.*?:\\d+`, 'g'));
    if (!matches) return { filename: filename, line: 1 };

    const [lastItem] = matches.slice(-1);
    const [, line] = lastItem.split(':');
    core.debug(`Resolved file ${filename} and line ${line}`);

    return { filename, line: parseInt(line) };
};

const resolvePath = async filename => {
    core.debug(`Resolving path for ${filename}`);
    const globber = await glob.create(`**/${filename}.*`, { followSymbolicLinks: false });
    const results = await globber.glob();
    core.debug(`Matched files: ${results}`);
    const searchPath = globber.getSearchPaths()[0];

    let path = '';
    if (results.length) {
        // skip various temp folders
        const found = results.find(r => !r.includes('__pycache__') && !r.endsWith('.class'));
        if (found) path = found.slice(searchPath.length + 1);
        else path = filename;
    } else {
        path = filename;
    }
    core.debug(`Resolved path: ${path}`);

    // canonicalize to make windows paths use forward slashes
    const canonicalPath = path.replace(/\\/g, '/');
    core.debug(`Canonical path: ${canonicalPath}`);

    return canonicalPath;
};

async function parseFile(file) {
    core.debug(`Parsing file ${file}`);
    let count = 0;
    let skipped = 0;
    let annotations = [];

    const data = await fs.promises.readFile(file);

    const report = JSON.parse(parser.xml2json(data, { compact: true }));
    const testsuites = report.testsuite
        ? [report.testsuite]
        : Array.isArray(report.testsuites.testsuite)
            ? report.testsuites.testsuite
            : [report.testsuites.testsuite];

    for (const testsuite of testsuites) {
        const testcases = Array.isArray(testsuite.testcase)
            ? testsuite.testcase
            : testsuite.testcase
                ? [testsuite.testcase]
                : [];
        for (const testcase of testcases) {
            count++;
            if (testcase.skipped) skipped++;
            if (testcase.failure || testcase.flakyFailure || testcase.error) {
                let testcaseData =
                    (testcase.failure && testcase.failure._cdata) ||
                    (testcase.failure && testcase.failure._text) ||
                    (testcase.flakyFailure && testcase.flakyFailure._cdata) ||
                    (testcase.flakyFailure && testcase.flakyFailure._text) ||
                    (testcase.error && testcase.error._cdata) ||
                    (testcase.error && testcase.error._text) ||
                    '';
                testcaseData = Array.isArray(testcaseData) ? testcaseData : [testcaseData];
                const stackTrace = (testcaseData.length ? testcaseData.join('') : '').trim();

                const message = (
                    (testcase.failure &&
                        testcase.failure._attributes &&
                        testcase.failure._attributes.message) ||
                    (testcase.flakyFailure &&
                        testcase.flakyFailure._attributes &&
                        testcase.flakyFailure._attributes.message) ||
                    (testcase.error &&
                        testcase.error._attributes &&
                        testcase.error._attributes.message) ||
                    stackTrace.split('\n').slice(0, 2).join('\n')
                ).trim();

                const { filename, line } = resolveFileAndLine(
                    testcase._attributes.file,
                    testcase._attributes.classname,
                    stackTrace
                );

                const path = await resolvePath(filename);
                const title = `${filename}.${testcase._attributes.name}`;
                core.info(`${path}:${line} | ${message.replace(/\n/g, ' ')}`);

                annotations.push({
                    path,
                    start_line: line,
                    end_line: line,
                    start_column: 0,
                    end_column: 0,
                    annotation_level: 'failure',
                    title,
                    message,
                    raw_details: stackTrace
                });
            }
        }
    }
    return { count, skipped, annotations };
}

const parseTestReports = async reportPaths => {
    const globber = await glob.create(reportPaths, { followSymbolicLinks: false });
    let annotations = [];
    let count = 0;
    let skipped = 0;
    for await (const file of globber.globGenerator()) {
        const { count: c, skipped: s, annotations: a } = await parseFile(file);
        if (c == 0) continue;
        count += c;
        skipped += s;
        annotations = annotations.concat(a);
    }
    return { count, skipped, annotations };
};

module.exports = { resolveFileAndLine, resolvePath, parseFile, parseTestReports };


/***/ }),

/***/ 927:
/***/ ((module) => {

module.exports = eval("require")("@actions/core");


/***/ }),

/***/ 273:
/***/ ((module) => {

module.exports = eval("require")("@actions/github");


/***/ }),

/***/ 837:
/***/ ((module) => {

module.exports = eval("require")("@actions/glob");


/***/ }),

/***/ 585:
/***/ ((module) => {

module.exports = eval("require")("@octokit/plugin-retry");


/***/ }),

/***/ 819:
/***/ ((module) => {

module.exports = eval("require")("@octokit/rest");


/***/ }),

/***/ 572:
/***/ ((module) => {

module.exports = eval("require")("xml-js");


/***/ }),

/***/ 147:
/***/ ((module) => {

"use strict";
module.exports = require("fs");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry need to be wrapped in an IIFE because it need to be isolated against other modules in the chunk.
(() => {
const core = __nccwpck_require__(927);
const action = __nccwpck_require__(33);

(async () => {
    try {
        await action();
    } catch (error) {
        core.setFailed(error.message);
    }
})();

})();

module.exports = __webpack_exports__;
/******/ })()
;