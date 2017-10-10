import path from 'path'
import child from 'child_process'
import * as jsonfile from 'jsonfile'
import * as fs from 'fs'

import ConfigParser from './utils/ConfigParser'
import BaseReporter from './utils/BaseReporter'

class Launcher {
    constructor (configFile, argv) {
        this.configParser = new ConfigParser()
        this.configParser.addConfigFile(configFile)
        this.configParser.merge(argv)

        this.reporters = this.initReporters()

        this.argv = argv
        this.configFile = configFile

        this.exitCode = 0
        this.hasTriggeredExitRoutine = false
        this.hasStartedAnyProcess = false
        this.processes = []
        this.schedule = []
        this.rid = []
        this.processesStarted = 0
        this.runnerFailed = 0

        // store verification results
        this.finishedTests = false
        this.verificationResults = {}
        this.verificationStates = {}
        this.stepStates = {}
        // this.uidStore = {}
        this.cidProcesses = {}

        this.endHandlerRunFunc = this.runTestcases
    }

    /**
     * check if multiremote or wdio test
     */
    isMultiremote () {
        let caps = this.configParser.getCapabilities()
        return !Array.isArray(caps)
    }

    /**
     * initialise reporters
     */
    initReporters () {
        let reporter = new BaseReporter()
        let config = this.configParser.getConfig()

        /**
         * if no reporter is set or config property is in a wrong format
         * just use the dot reporter
         */
        if (!config.reporters || !Array.isArray(config.reporters) || !config.reporters.length) {
            config.reporters = ['dot']
        }

        const reporters = {}

        for (let reporterName of config.reporters) {
            let Reporter
            if (typeof reporterName === 'function') {
                Reporter = reporterName
                if (!Reporter.reporterName) {
                    throw new Error('Custom reporters must export a unique \'reporterName\' property')
                }
                reporters[Reporter.reporterName] = Reporter
            } else if (typeof reporterName === 'string') {
                try {
                    Reporter = require(`wdio-${reporterName}-reporter`)
                } catch (e) {
                    throw new Error(`reporter "wdio-${reporterName}-reporter" is not installed. Error: ${e.stack}`)
                }
                reporters[reporterName] = Reporter
            }
            if (!Reporter) {
                throw new Error(`config.reporters must be an array of strings or functions, but got '${typeof reporterName}': ${reporterName}`)
            }
        }

        /**
         * if no reporter options are set or property is in a wrong format default to
         * empty object
         */
        if (!config.reporterOptions || typeof config.reporterOptions !== 'object') {
            config.reporterOptions = {}
        }

        for (let reporterName in reporters) {
            const Reporter = reporters[reporterName]
            let reporterOptions = {}
            for (let option of Object.keys(config.reporterOptions)) {
                if (option === reporterName && typeof config.reporterOptions[reporterName] === 'object') {
                    // Copy over options specifically for this reporter type
                    reporterOptions = Object.assign(reporterOptions, config.reporterOptions[reporterName])
                } else if (reporters[option]) {
                    // Don't copy options for other reporters
                    continue
                } else {
                    // Copy over generic options
                    reporterOptions[option] = config.reporterOptions[option]
                }
            }

            reporter.add(new Reporter(reporter, config, reporterOptions))
        }

        return reporter
    }

    /**
     * run sequence
     * @return  {Promise} that only gets resolves with either an exitCode or an error
     */
    async run () {
        let config = this.configParser.getConfig()
        let caps = this.configParser.getCapabilities()
        let launcher = this.getLauncher(config)

        this.reporters.handleEvent('start', {
            isMultiremote: this.isMultiremote(),
            capabilities: caps,
            config
        })

        // this.importUidStore(config)

        /**
         * run onPrepare hook
         */
        await config.onPrepare(config, caps)
        await this.runServiceHook(launcher, 'onPrepare', config, caps)

        /**
         * if it is an object run multiremote test
         */
        if (this.isMultiremote()) {
            let exitCode = await new Promise((resolve) => {
                this.resolve = resolve
                this.startRunnerInstance(this.configParser.getTestcases(), caps, 0)
            })

            /**
             * run onComplete hook for multiremote
             */
            await this.runServiceHook(launcher, 'onComplete', exitCode, config, caps)
            await config.onComplete(exitCode, config, caps)

            return exitCode
        }

        /**
         * schedule test runs
         */
        let cid = 0
        for (let capabilities of caps) {
            this.schedule.push({
                cid: cid++,
                caps: capabilities,
                testcases: this.configParser.getTestcases(capabilities.testcases, capabilities.exclude),
                availableInstances: capabilities.maxInstances || config.maxInstancesPerCapability,
                runningInstances: 0,
                seleniumServer: { host: config.host, port: config.port, protocol: config.protocol }
            })
        }

        /**
         * catches ctrl+c event
         */
        process.on('SIGINT', this.exitHandler.bind(this))

        /**
         * make sure the program will not close instantly
         */
        if (process.stdin.isPaused()) {
            process.stdin.resume()
        }

        let exitCode = await new Promise((resolve) => {
            this.resolve = resolve

            /**
             * return immediatelly if no spec was run
             */
            if (this.runTestcases()) {
                resolve(0)
            }
        })

        // this.exportUidStore(config)

        /**
         * run onComplete hook
         */
        await this.runServiceHook(launcher, 'onComplete', exitCode, config, caps)
        await config.onComplete(exitCode, config, caps)

        // run specs
        this.finishedTests = true

        cid = 0
        this.schedule = []
        for (let capabilities of caps) {
            this.schedule.push({
                cid: cid++,
                caps: capabilities,
                specs: this.configParser.getSpecs(capabilities.specs, capabilities.exclude),
                availableInstances: capabilities.maxInstances || config.maxInstancesPerCapability,
                runningInstances: 0,
                seleniumServer: { host: config.host, port: config.port, protocol: config.protocol }
            })
        }

        this.endHandlerRunFunc = this.runSpecs

        this.mergeManualTestcaseResults()

        await new Promise((resolve) => {
            this.resolve = resolve

            /**
             * return immediatelly if no spec was run
             */
            if (this.runSpecs()) {
                resolve(0)
            }
        })

        return exitCode
    }

    importUidStore (config) {
        if (fs.existsSync(config.uidStorePath)) {
            this.uidStore = jsonfile.readFileSync(config.uidStorePath)
        }
    }

    exportUidStore (config) {
        if (fs.existsSync(config.uidStorePath)) {
            fs.unlinkSync(config.uidStorePath)
        }

        jsonfile.writeFileSync(config.uidStorePath, this.uidStore)
    }

    mergeManualTestcaseResults () {
        let manualResults = this.configParser.getManualResults()
        const cid = '0-0'

        if (manualResults) {
            for (const filename of manualResults) {
                const manualTestcase = require(filename).default

                // how to treat different capabilities???
                if (!(this.getCidGroup(cid) in this.verificationResults)) {
                    this.verificationResults[this.getCidGroup(cid)] = {}
                }

                for (const story in manualTestcase) {
                    if (!(story in this.verificationResults[this.getCidGroup(cid)])) {
                        this.verificationResults[this.getCidGroup(cid)][story] = {
                            successes: {},
                            failures: {},
                            arguments: {},
                            screenshots: {}
                        }
                    }
                    for (const criteria in manualTestcase[story]) {
                        if (manualTestcase[story][criteria].result === true) {
                            if (!(criteria in this.verificationResults[this.getCidGroup(cid)][story])) {
                                this.verificationResults[this.getCidGroup(cid)][story].successes[criteria] = []
                            }

                            this.verificationResults[this.getCidGroup(cid)][story].successes[criteria].push({})
                        } else {
                            if (!(criteria in this.verificationResults[this.getCidGroup(cid)][story])) {
                                this.verificationResults[this.getCidGroup(cid)][story].failures[criteria] = []
                            }

                            this.verificationResults[this.getCidGroup(cid)][story].failures[criteria].push({
                                message: `Spec ${story}: Then ${criteria} failed manual tests!`,
                                stack: ''
                            })
                        }

                        this.verificationResults[this.getCidGroup(cid)][story].arguments[criteria] = {
                            date: {
                                caption: 'Last manual execution',
                                value: manualTestcase[story][criteria].date
                            },
                            comment: {
                                caption: 'Comment',
                                value: manualTestcase[story][criteria].comment
                            }
                        }
                    }
                }
            }
        }
    }

    // need to figure out multiple capabilities...
    getVerificationResults () {
        return this.verificationResults['0']
    }

    /**
     * run service launch sequences
     */
    async runServiceHook (launcher, hookName, ...args) {
        try {
            return await Promise.all(launcher.map((service) => {
                if (typeof service[hookName] === 'function') {
                    return service[hookName](...args)
                }
            }))
        } catch (e) {
            console.error(`A service failed in the '${hookName}' hook\n${e.stack}\n\nContinue...`)
        }
    }

    /**
     * run multiple single remote tests
     * @return {Boolean} true if all specs have been run and all instances have finished
     */
    runTestcases () {
        let config = this.configParser.getConfig()

        /**
         * stop spawning new processes when CTRL+C was triggered
         */
        if (this.hasTriggeredExitRoutine) {
            return true
        }

        while (this.getNumberOfRunningInstances() < config.maxInstances) {
            let schedulableCaps = this.schedule
                /**
                 * bail if number of errors exceeds allowed
                 */
                .filter(() => {
                    const filter = typeof config.bail !== 'number' || config.bail < 1 ||
                        config.bail > this.runnerFailed

                    /**
                     * clear number of specs when filter is false
                     */
                    if (!filter) {
                        this.schedule.forEach((t) => { t.testcases = [] })
                    }

                    return filter
                })
                /**
                 * make sure complete number of running instances is not higher than general maxInstances number
                 */
                .filter((a) => this.getNumberOfRunningInstances() < config.maxInstances)
                /**
                 * make sure the capabiltiy has available capacities
                 */
                .filter((a) => a.availableInstances > 0)
                /**
                 * make sure capabiltiy has still caps to run
                 */
                .filter((a) => a.testcases.length > 0)
                /**
                 * make sure we are running caps with less running instances first
                 */
                .sort((a, b) => a.runningInstances > b.runningInstances)

            /**
             * continue if no capabiltiy were schedulable
             */
            if (schedulableCaps.length === 0) {
                break
            }

            this.startRunnerInstance(
                [schedulableCaps[0].testcases.shift()],
                schedulableCaps[0].caps,
                schedulableCaps[0].cid,
                schedulableCaps[0].seleniumServer
            )
            schedulableCaps[0].availableInstances--
            schedulableCaps[0].runningInstances++
        }

        return this.getNumberOfRunningInstances() === 0 && this.getNumberOfTestcasesLeft() === 0
    }

    runSpecs () {
        let config = this.configParser.getConfig()

        /**
         * stop spawning new processes when CTRL+C was triggered
         */
        if (this.hasTriggeredExitRoutine) {
            return true
        }

        while (this.getNumberOfRunningInstances() < config.maxInstances) {
            let schedulableCaps = this.schedule
                /**
                 * bail if number of errors exceeds allowed
                 */
                .filter(() => {
                    const filter = typeof config.bail !== 'number' || config.bail < 1 ||
                        config.bail > this.runnerFailed

                    /**
                     * clear number of specs when filter is false
                     */
                    if (!filter) {
                        this.schedule.forEach((t) => { t.specs = [] })
                    }

                    return filter
                })
                /**
                 * make sure complete number of running instances is not higher than general maxInstances number
                 */
                .filter((a) => this.getNumberOfRunningInstances() < config.maxInstances)
                /**
                 * make sure the capabiltiy has available capacities
                 */
                .filter((a) => a.availableInstances)
                /**
                 * make sure capabiltiy has still caps to run
                 */
                .filter((a) => a.specs.length > 0)
                /**
                 * make sure we are running caps with less running instances first
                 */
                .sort((a, b) => a.runningInstances > b.runningInstances)

            /**
             * continue if no capabiltiy were schedulable
             */
            if (schedulableCaps.length === 0) {
                break
            }

            this.startVerifierInstance(
                [schedulableCaps[0].specs.shift()],
                schedulableCaps[0].caps,
                schedulableCaps[0].cid
            )
            schedulableCaps[0].availableInstances--
            schedulableCaps[0].runningInstances++
        }

        return this.getNumberOfRunningInstances() === 0 && this.getNumberOfSpecsLeft() === 0
    }

    /**
     * gets number of all running instances
     * @return {number} number of running instances
     */
    getNumberOfRunningInstances () {
        return this.schedule.map((a) => a.runningInstances).reduce((a, b) => a + b)
    }

    /**
     * get number of total testcases left to complete whole suites
     * @return {number} testcases left to complete suite
     */
    // TODO: formulate differently -> testcases are only indirectly linked to spec suites!
    getNumberOfTestcasesLeft () {
        return this.schedule.map((a) => a.testcases.length).reduce((a, b) => a + b)
    }

    getNumberOfSpecsLeft () {
        return this.schedule.map((a) => a.specs.length).reduce((a, b) => a + b)
    }

    /**
     * Start instance in a child process.
     * @param  {Array} specs  Specs to run
     * @param  {Number} cid  Capabilities ID
     */
    startRunnerInstance (specs, caps, cid, server) {
        let config = this.configParser.getConfig()
        let debug = caps.debug || config.debug
        cid = this.getRunnerId(cid)
        let processNumber = this.processesStarted + 1

        // process.debugPort defaults to 5858 and is set even when process
        // is not being debugged.
        let debugArgs = (debug)
            ? [`--debug=${(process.debugPort + processNumber)}`]
            : []

        // if you would like to add --debug-brk, use a different port, etc...
        let capExecArgs = [
            ...(config.execArgv || []),
            ...(caps.execArgv || [])
        ]

        // The default value for child.fork execArgs is process.execArgs,
        // so continue to use this unless another value is specified in config.
        let defaultArgs = (capExecArgs.length) ? process.execArgv : []

        // If an arg appears multiple times the last occurence is used
        let execArgv = [...defaultArgs, ...debugArgs, ...capExecArgs]

        let childProcess = child.fork(path.join(__dirname, '/runner.js'), process.argv.slice(2), {
            cwd: process.cwd(),
            execArgv
        })

        this.processes.push(childProcess)

        this.cidProcesses[cid] = childProcess

        childProcess
            .on('message', this.messageHandler.bind(this, cid))
            .on('exit', this.endHandler.bind(this, cid))

        childProcess.send({
            cid,
            command: 'run',
            configFile: this.configFile,
            argv: this.argv,
            caps,
            processNumber,
            specs,
            server,
            isMultiremote: this.isMultiremote()
        })

        this.processesStarted++
    }

    /**
     * Start instance in a child process.
     * @param  {Array} specs  Specs to run
     * @param  {Number} cid  Capabilities ID
     */
    startVerifierInstance (specs, caps, cid, server) {
        let config = this.configParser.getConfig()
        let debug = caps.debug || config.debug
        cid = this.getRunnerId(cid)
        let processNumber = this.processesStarted + 1

        // process.debugPort defaults to 5858 and is set even when process
        // is not being debugged.
        let debugArgs = (debug)
            ? [`--debug=${(process.debugPort + processNumber)}`]
            : []

        // if you would like to add --debug-brk, use a different port, etc...
        let capExecArgs = [
            ...(config.execArgv || []),
            ...(caps.execArgv || [])
        ]

        // The default value for child.fork execArgs is process.execArgs,
        // so continue to use this unless another value is specified in config.
        let defaultArgs = (capExecArgs.length) ? process.execArgv : []

        // If an arg appears multiple times the last occurence is used
        let execArgv = [...defaultArgs, ...debugArgs, ...capExecArgs]

        let childProcess = child.fork(path.join(__dirname, '/verifier.js'), process.argv.slice(2), {
            cwd: process.cwd(),
            execArgv
        })

        this.processes.push(childProcess)

        this.cidProcesses[cid] = childProcess

        childProcess
            .on('message', this.messageHandler.bind(this, cid))
            .on('exit', this.endHandler.bind(this, cid))

        const verificationResults = this.getVerificationResults()

        childProcess.send({
            cid,
            command: 'run',
            configFile: this.configFile,
            argv: this.argv,
            caps,
            processNumber,
            specs,
            verificationResults,
            isMultiremote: this.isMultiremote()
        })

        this.processesStarted++
    }

    /**
     * generates a runner id
     * @param  {Number} cid capability id (unique identifier for a capability)
     * @return {String}     runner id (combination of cid and test id e.g. 0a, 0b, 1a, 1b ...)
     */
    getRunnerId (cid) {
        if (!this.rid[cid]) {
            this.rid[cid] = 0
        }
        return `${cid}-${this.rid[cid]++}`
    }

    getCidGroup (cid) {
        return cid.split('-')[0]
    }

    /**
     * emit event from child process to reporter
     * @param  {String} cid
     * @param  {Object} m event object
     */
    messageHandler (cid, m) {
        this.hasStartedAnyProcess = true

        if (!m.cid) {
            m.cid = cid
        }

        if (m.event === 'runner:error') {
            this.reporters.handleEvent('error', m)
        }

        if (m.event === 'uid:request') {
            if (!(m.id in this.uidStore)) {
                this.uidStore[m.id] = 0
            }

            this.cidProcesses[m.cid].send({
                event: 'uid:response',
                id: `${m.id}_${++this.uidStore[m.id]}`,
                cid: m.cid
            })
        }

        if (m.event.indexOf('test:') === 0) {
            if (m.title) {
                const testData = JSON.parse(m.title)

                m.title = testData.title
                m.metadata = testData.metadata
            }
        }

        if (m.event === 'test:start') {
            m.spec = m.specs[0]
        }

        if (this.finishedTests) {
            switch (m.event) {
            case 'step:end':
                m.status = 'passed'

                if (m.verify) {
                    if (!this.verificationStates[this.getCidGroup(m.cid)]) {
                        this.verificationStates[this.getCidGroup(m.cid)] = {}
                    }
                    this.verificationStates[this.getCidGroup(m.cid)].storyId = m.verify.storyId
                    this.verificationStates[this.getCidGroup(m.cid)].criteriaId = m.verify.criteriaId

                    const status = this.evaluateVerifications(m.verify.storyId, m.verify.criteriaId, m)
                    m.event = `step:${status}`
                }
                break
            case 'test:pass':
                const storyId = this.verificationStates[this.getCidGroup(m.cid)].storyId
                const criteriaId = this.verificationStates[this.getCidGroup(m.cid)].criteriaId

                const status = this.evaluateVerifications(storyId, criteriaId, m)
                m.event = `test:${status}`

                this.addTestArguments(storyId, criteriaId, m)

                break
            }

            this.reporters.handleEvent(m.event, m)
        } else {
            if (m.event === 'test:fail') {
                if (m.errs) {
                    m.err.message = ''
                    m.err.stack = ''

                    if (!(this.getCidGroup(m.cid) in this.verificationResults)) {
                        this.verificationResults[this.getCidGroup(m.cid)] = {}
                    }

                    for (const err of m.errs) {
                        if (err.specObj) {
                            for (const key of Object.keys(err.specObj)) {
                                if (!(key in this.verificationResults[this.getCidGroup(m.cid)])) {
                                    this.verificationResults[this.getCidGroup(m.cid)][key] = {
                                        successes: {},
                                        failures: {},
                                        arguments: {},
                                        screenshots: {}
                                    }
                                }
                                for (const criteria of err.specObj[key]) {
                                    if (!(criteria in this.verificationResults[this.getCidGroup(m.cid)][key])) {
                                        this.verificationResults[this.getCidGroup(m.cid)][key].failures[criteria] = []
                                    }
                                    this.verificationResults[this.getCidGroup(m.cid)][key].failures[criteria].push({
                                        matcherName: err.matcherName,
                                        message: err.message,
                                        expected: err.expected,
                                        actual: err.actual,
                                        stack: err.stack
                                    })
                                }
                            }
                        }
                        // once a test is broken set all to broken
                        if (!err.matcherName) {
                            m.event = 'test:broken'
                            err.matcherName = undefined
                        }
                        m.err.message += err.message + '\n\n'
                        m.err.stack += err.stack + '\n\n'
                    }
                }
            }

            if (m.event === 'step:start') {
                if (!this.stepStates[this.getCidGroup(m.cid)]) {
                    this.stepStates[this.getCidGroup(m.cid)] = {
                        stepLevel: 0
                    }
                }

                if (this.stepStates[this.getCidGroup(m.cid)].stepLevel === 0) {
                    this.stepStates[this.getCidGroup(m.cid)].levelStatus = []
                }

                this.stepStates[this.getCidGroup(m.cid)].stepLevel++

                if (this.stepStates[this.getCidGroup(m.cid)].levelStatus.length < this.stepStates[this.getCidGroup(m.cid)].stepLevel) {
                    this.stepStates[this.getCidGroup(m.cid)].levelStatus.push('passed')
                }
            }

            if (m.event === 'step:end') {
                const levelStatus = this.stepStates[this.getCidGroup(m.cid)].levelStatus

                if (levelStatus.length > this.stepStates[this.getCidGroup(m.cid)].stepLevel) {
                    // if step is a parent step let its result be defined by children's results
                    m.status = levelStatus[levelStatus.length - 1]
                } else {
                    m.status = 'passed'
                }

                if (this.verificationStates[this.getCidGroup(m.cid)] && this.verificationStates[this.getCidGroup(m.cid)].assertionFailures) {
                    m.assertionFailures = this.verificationStates[this.getCidGroup(m.cid)].assertionFailures
                    m.screenshots = this.verificationStates[this.getCidGroup(m.cid)].screenshots
                    m.status = 'failed'
                    levelStatus[levelStatus.length - 1] = 'failed'

                    this.verificationStates[this.getCidGroup(m.cid)].assertionFailures = undefined
                    this.verificationStates[this.getCidGroup(m.cid)].screenshots = undefined
                }

                this.stepStates[this.getCidGroup(m.cid)].stepLevel--
            }

            // filter for verification events and store their results
            if (m.event === 'verify:success' || m.event === 'verify:failure') {
                if (!(this.getCidGroup(m.cid) in this.verificationResults)) {
                    this.verificationResults[this.getCidGroup(m.cid)] = {}
                }

                for (const key of Object.keys(m.assertion.specObj)) {
                    if (!(key in this.verificationResults[this.getCidGroup(m.cid)])) {
                        this.verificationResults[this.getCidGroup(m.cid)][key] = {
                            successes: {},
                            failures: {},
                            arguments: {},
                            screenshots: {}
                        }
                    }

                    const story = this.verificationResults[this.getCidGroup(m.cid)][key]

                    if (m.event === 'verify:success') {
                        for (const criteria of m.assertion.specObj[key]) {
                            if (!(criteria in story.successes)) {
                                story.successes[criteria] = []
                            }
                            story.successes[criteria].push({
                                matcherName: m.assertion.matcherName,
                                actual: m.assertion.actual,
                                expected: m.assertion.expected
                            })
                        }
                    } else {
                        for (const criteria of m.assertion.specObj[key]) {
                            if (!(criteria in story.failures)) {
                                story.failures[criteria] = []
                            }
                            if (!this.verificationStates[this.getCidGroup(m.cid)]) {
                                this.verificationStates[this.getCidGroup(m.cid)] = {}
                            }
                            if (!this.verificationStates[this.getCidGroup(m.cid)].assertionFailures) {
                                this.verificationStates[this.getCidGroup(m.cid)].assertionFailures = []
                            }
                            if (!this.verificationStates[this.getCidGroup(m.cid)].screenshots) {
                                this.verificationStates[this.getCidGroup(m.cid)].screenshots = {}
                            }

                            if (m.assertion.screenshotFilename) {
                                if (!(criteria in story.screenshots)) {
                                    story.screenshots[criteria] = {}
                                }

                                if (!(m.assertion.message in story.screenshots[criteria])) {
                                    story.screenshots[criteria][m.assertion.message] = []
                                }

                                story.screenshots[criteria][m.assertion.message].push(m.assertion.screenshotFilename)
                            }

                            const screenshots = this.verificationStates[this.getCidGroup(m.cid)].screenshots

                            if (!(m.assertion.message in screenshots)) {
                                screenshots[m.assertion.message] = []
                            }

                            screenshots[m.assertion.message].push(m.assertion.screenshotFilename)

                            this.verificationStates[this.getCidGroup(m.cid)].assertionFailures.push(m.assertion)
                        }
                    }
                }
            } else {
                this.reporters.handleEvent(m.event, m)
            }
        }
    }

    // add test arguments for reporters to message m
    addTestArguments (storyId, criteriaId, m) {
        if (this.verificationResults && this.verificationResults[this.getCidGroup(m.cid)] && this.verificationResults[this.getCidGroup(m.cid)][storyId]) {
            const story = this.verificationResults[this.getCidGroup(m.cid)][storyId]

            m.arguments = story.arguments[criteriaId]
        }
    }

    evaluateVerifications (storyId, criteriaId, m) {
        if (this.verificationResults && this.verificationResults[this.getCidGroup(m.cid)] && this.verificationResults[this.getCidGroup(m.cid)][storyId]) {
            const story = this.verificationResults[this.getCidGroup(m.cid)][storyId]

            if (story.failures[criteriaId]) {
                // some verifications failed
                m.err = {
                    message: story.failures[criteriaId].map(
                        (err) => err.message
                    ).reduce((prev, cur) => prev + '\n' + cur) + '\n',
                    stack: story.failures[criteriaId].map(
                        (err) => err.stack
                    ).reduce((prev, cur) => prev + '\n\n' + cur),
                    matcherName: ''
                }

                m.screenshots = story.screenshots[criteriaId]

                return 'fail'
            } else if (!story.failures[criteriaId] && story.successes[criteriaId]) {
                // all verifications succeeded
                return 'pass'
            }
        }

        // criteria was not verified at all
        m.err = {
            message: `Spec ${storyId}: Then ${criteriaId} was not verified!`
        }

        return 'unverified'
    }

    /**
     * Close test runner process once all child processes have exited
     * @param  {Number} cid  Capabilities ID
     * @param  {Number} childProcessExitCode  exit code of child process
     */
    endHandler (cid, childProcessExitCode) {
        this.exitCode = this.exitCode || childProcessExitCode
        this.runnerFailed += childProcessExitCode !== 0 ? 1 : 0

        // Update schedule now this process has ended
        if (!this.isMultiremote()) {
            // get cid (capability id) from rid (runner id)
            cid = parseInt(cid, 10)

            this.schedule[cid].availableInstances++
            this.schedule[cid].runningInstances--
        }

        if (!this.isMultiremote() && !this.endHandlerRunFunc()) {
            return
        }

        this.reporters.handleEvent('end', {
            sigint: this.hasTriggeredExitRoutine,
            exitCode: this.exitCode,
            isMultiremote: this.isMultiremote(),
            capabilities: this.configParser.getCapabilities(),
            config: this.configParser.getConfig()
        })

        if (this.exitCode === 0) {
            return this.resolve(this.exitCode)
        }

        /**
         * finish with exit code 1
         */
        return this.resolve(1)
    }

    /**
     * Make sure all started selenium sessions get closed properly and prevent
     * having dead driver processes. To do so let the runner end its Selenium
     * session first before killing
     */
    exitHandler () {
        if (this.hasTriggeredExitRoutine || !this.hasStartedAnyProcess) {
            console.log('\nKilling process, bye!')

            // When spawned as a subprocess,
            // SIGINT will not be forwarded to childs.
            // Thus for the child to exit cleanly, we must force send SIGINT
            if (!process.stdin.isTTY) {
                this.processes.forEach(p => p.kill('SIGINT'))
            }

            /**
             * finish with exit code 1
             */
            return this.resolve(1)
        }

        // When spawned as a subprocess,
        // SIGINT will not be forwarded to childs.
        // Thus for the child to exit cleanly, we must force send SIGINT
        if (!process.stdin.isTTY) {
            this.processes.forEach(p => p.kill('SIGINT'))
        }

        console.log(`

End selenium sessions properly ...
(press ctrl+c again to hard kill the runner)
`)

        this.hasTriggeredExitRoutine = true
    }

    /**
     * loads launch services
     */
    getLauncher (config) {
        let launchServices = []

        if (!Array.isArray(config.services)) {
            return launchServices
        }

        for (let serviceName of config.services) {
            let service

            /**
             * allow custom services
             */
            if (typeof serviceName === 'object') {
                launchServices.push(serviceName)
                continue
            }

            try {
                service = require(`wdio-${serviceName}-service/launcher`)
            } catch (e) {
                if (!e.message.match(`Cannot find module 'wdio-${serviceName}-service/launcher'`)) {
                    throw new Error(`Couldn't initialise launcher from service "${serviceName}".\n${e.stack}`)
                }
            }

            if (service && typeof service.onPrepare === 'function') {
                launchServices.push(service)
            }
        }

        return launchServices
    }
}

export default Launcher
