const axios = require('axios');
const _ = require('lodash');
const { compareResponse } = require('../utils/common');
const { logTestPassed, logTestFailed, logAppError } = require('../utils/cmdPrint');

async function makeTestRequest(test, showPassedLog = true, showFailedLog = true) {
    try {
        let options = {
            method: test.method,
            url: test.url,
            headers: _.extend({'cache-control': 'no-cache', 'pythagora-req-id': test.id}, _.omit(test.headers, ['content-length', 'cache-control'])),
            maxRedirects: 0,
            cache: false,
            validateStatus: function (status) {
                return status >= 100 && status < 600;
            },
            transformResponse: (r) => r
        };
        if (test.method !== 'GET') {
            options.data = test.body;
        }
        const response = await axios(options).catch(e => {
            logAppError('⚠️ Pythagora encountered error while making a request', e.stack);
            return e.response;
        });
        // TODO fix this along with managing the case where a request is overwritter during the capture so doesn't exist during capture filtering
        if (!global.Pythagora.request) return false;

        if(response.status >= 300 && response.status < 400) {
            response.data = {type: 'redirect', url: `${response.headers.location}`};
        }
        // TODO we should compare JSON files and ignore _id during creation because it changes every time
        let testResult = compareResponse(response.data, test.responseData);

        testResult = testResult ? test.statusCode === response.status : testResult;
        testResult = global.Pythagora.request.id === test.id && global.Pythagora.request.errors.length ? false : testResult;

        // horrible - please refactor at one point
        _.values(global.Pythagora.testingRequests).find(v => v.id === test.id).passed = testResult;
        // TODO add query
        if (showPassedLog && testResult) logTestPassed(test);
        if (showFailedLog && !testResult) logTestFailed(test);
        return testResult;
    } catch (error) {
        console.error(error);
    }
}

module.exports = {
    makeTestRequest
}
