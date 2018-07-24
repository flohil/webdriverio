import tty from 'tty'
import events from 'events'
import supportsColor from 'supports-color'
import sanitize from '../helpers/sanitize'
import { ReporterStats } from './ReporterStats'
import * as fs from 'fs'
import * as path from 'path'
import merge from 'deepmerge'

const ISATTY = tty.isatty(1) && tty.isatty(2)

export const COLORS = {
    'pass': 90,
    'fail': 31,
    'failed': 31,
    'bright pass': 92,
    'bright fail': 91,
    'bright yellow': 93,
    'unvalidated': 35,
    'broken': 93,
    'pending': 36,
    'suite': 0,
    'error title': 0,
    'browser': 0,
    'error message': 31,
    'error stack': 90,
    'checkmark': 32,
    'fast': 90,
    'medium': 33,
    'slow': 31,
    'green': 32,
    'passed': 32,
    'light': 90,
    'unknown': 90,
    'diff gutter': 90,
    'diff added': 32,
    'diff removed': 31
}

export const SYMBOLS_WIN = {
    ok: '\u221A',
    err: '\u00D7',
    dot: '.',
    error: 'F'
}

export const SYMBOLS = {
    ok: '✓',
    err: '✖',
    dot: '․',
    error: 'F'
}

class BaseReporter extends events.EventEmitter {
    constructor (config) {
        super()

        this.reporters = []
        this.printEpilogue = true
        this.cursor = new Cursor()
        this.stats = new ReporterStats()
        this.config = config
        this.startedSpecs = false
        this.currentPrintTitle = undefined
        this.currentTestId = undefined
        this.currentSpecId = undefined
        this.currentCriteriaId = undefined

        this.testcaseResultCounts = {
            passing: {
                count: 0,
                percentage: 0
            },
            skipped: {
                count: 0,
                percentage: 0
            },
            unvalidated: {
                count: 0,
                percentage: 0
            },
            failing: {
                count: 0,
                percentage: 0
            },
            broken: {
                count: 0,
                percentage: 0
            }
        }

        this.specResultCounts = {
            passing: {
                count: 0,
                percentage: 0
            },
            skipped: {
                count: 0,
                percentage: 0
            },
            unvalidated: {
                count: 0,
                percentage: 0
            },
            failing: {
                count: 0,
                percentage: 0
            },
            broken: {
                count: 0,
                percentage: 0
            }
        }

        this.testcaseResults = {}
        this.specResults = {}

        this.completeOuput = []
        this.wroteCompleteOuput = false

        this.log = function (...args) {
            this.completeOuput.push({
                type: 'log',
                arguments: args
            })

            console.log(...args)
        }

        this.warn = function (...args) {
            this.completeOuput.push({
                type: 'log',
                arguments: args
            })

            console.warn(...args)
        }

        this.error = function (...args) {
            this.completeOuput.push({
                type: 'log',
                arguments: args
            })

            console.error(...args)
        }

        this.writeCompleteOutput = function () {
            if (!this.wroteCompleteOuput) {
                fs.writeFileSync(this.config.consoleReportPath, JSON.stringify(this.completeOuput), 'utf8')

                this.wroteCompleteOuput = true
            }
        }

        this.on('startSpecs', (runner) => {
            if (!this.startedSpecs) {
                this.startedSpecs = true
                this.testcaseDuration = this.stats.getTestcaseDuration()
                this.stats.reset(true)
            }
        })

        this.on('test:setCurrentId', (test) => {
            if (this.startedSpecs) {
                const parts = test.id.split('|')
                const spec = parts[0]
                const criteria = parts[1]

                this.currentSpecId = spec
                this.currentCriteriaId = criteria

                this.currentPrintTitle = `${spec} ${test.descriptions.spec} [${criteria} - ${test.descriptions.criteria}]`
            } else {
                this.currentPrintTitle = test.id
                this.currentTestId = test.id
            }
        })

        this.on('start', () => {
        })

        this.on('runner:start', (runner) => {
            this.stats.runnerStart(runner)
            this.stats.specStart(runner)
        })

        this.on('runner:init', (runner) => {
            this.stats.setSessionId(runner)
        })

        this.on('runner:beforecommand', (command) => {
            this.stats.output('beforecommand', command)
        })

        this.on('runner:command', (command) => {
            this.stats.output('command', command)
        })

        this.on('runner:aftercommand', (command) => {
            this.stats.output('aftercommand', command)
        })

        this.on('runner:result', (result) => {
            this.stats.output('result', result)
        })

        this.on('runner:screenshot', (screenshot) => {
            this.stats.output('screenshot', screenshot)
        })

        this.on('runner:log', (log) => {
            this.stats.output('log', log)
        })

        this.on('suite:start', (suite) => {
            this.stats.suiteStart(suite)
        })

        this.on('hook:start', (hook) => {
            this.stats.hookStart(hook)
        })

        this.on('hook:end', (hook) => {
            this.stats.hookEnd(hook)
        })

        this.on('test:start', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testStart(test)
        })

        this.on('test:pass', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testPass(test)
            this.setResults(test, 'passed')
        })

        this.on('test:fail', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testFail(test)
            this.setResults(test, 'failed')
        })

        this.on('test:broken', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testBroken(test)
            this.setResults(test, 'broken')
        })

        this.on('test:pending', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testPending(test)
            this.setResults(test, 'pending')
        })

        this.on('test:unvalidated', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testunvalidated(test)
            this.setResults(test, 'unvalidated')
        })

        this.on('test:end', (test) => {
            this.stats.testEnd(test)
        })

        this.on('suite:end', (runner) => {
            this.stats.suiteEnd(runner)
        })

        this.on('error', (runner) => {
            this.printEpilogue = false

            var fmt = this.color('error message', 'ERROR: %s')
            this.log(fmt, runner.error.message)

            fmt = this.color('bright yellow', sanitize.caps(runner.capabilities))
            this.log(fmt)

            if (runner.error.stack) {
                fmt = this.color('error stack', runner.error.stack.replace(`Error: ${runner.error.message}\n`, ''))
            } else {
                fmt = this.color('error stack', '    no stack available')
            }
            this.log(fmt)
        })

        this.on('runner:end', (runner) => {
            this.stats.runnerEnd(runner)
        })

        this.on('end', (args) => {
            this.stats.complete()
            this.printEpilogue = this.printEpilogue && !args.sigint

            // don't write execution results if execution was interrupted
            if (!args.sigint) {
                this.writeResults()
            }
        })
    }

    setResults (data, status) {
        if (this.startedSpecs) {
            if (!(this.currentSpecId in this.specResults)) {
                this.specResults[this.currentSpecId] = {}
            }

            // add datetime field for manual results
            this.specResults[this.currentSpecId][this.currentCriteriaId] = {
                status: status
            }

            if (data.arguments && data.arguments.date) {
                this.specResults[this.currentSpecId][this.currentCriteriaId].dateTime = `${data.arguments.date.value}_00-00-00`
                this.specResults[this.currentSpecId][this.currentCriteriaId].manual = true
            } else {
                this.specResults[this.currentSpecId][this.currentCriteriaId].dateTime = this.config.dateTime
            }

            this.specResults[this.currentSpecId][this.currentCriteriaId].resultsFolder = this.config.dateTime
        } else {
            this.testcaseResults[this.currentTestId] = {
                status: status,
                dateTime: this.config.dateTime,
                resultsFolder: this.config.dateTime
            }
        }
    }

    writeResults () {
        const latestRun = fs.readFileSync(this.config.latestRunPath, 'utf8')
        const currentResultPath = path.join(this.config.resultsPath, latestRun)
        const resultsFilePath = path.join(currentResultPath, 'results.json')

        const results = {
            testcases: this.testcaseResults,
            specs: this.specResults,
            browser: this.config.browserName
        }

        if (!fs.existsSync(currentResultPath)) {
            fs.mkdirSync(currentResultPath)
        }

        fs.writeFileSync(resultsFilePath, JSON.stringify(results), 'utf8')

        let mergedResults = {}

        if (fs.existsSync(this.config.mergedResultsPath)) {
            mergedResults = JSON.parse(fs.readFileSync(this.config.mergedResultsPath, 'utf8'))
            fs.unlinkSync(this.config.mergedResultsPath)
        }

        mergedResults = merge(mergedResults, results)

        fs.writeFileSync(this.config.mergedResultsPath, JSON.stringify(mergedResults), 'utf8')
    }

    trim (str) {
        return str.replace(/^\s+|\s+$/g, '')
    }

    /**
     * Color `str` with the given `type`,
     * allowing colors to be disabled,
     * as well as user-defined color
     * schemes.
     *
     * @param {String} type
     * @param {String} str
     * @return {String}
     * @api private
     */
    color (type, str) {
        if (!supportsColor.supportsColor().hasBasic) return String(str)
        return `\u001b[${COLORS[type]}m${str}\u001b[0m`
    }

    limit (val) {
        return sanitize.limit(val)
    }

    printTestcaseSuitesSummary () {
        this.log('Number of Testcase Files: ' + Object.keys(this.config.executionFilters.testcaseFiles).length)
        this.log('Number of Suites: ' + Object.keys(this.config.executionFilters.suites).length)
        this.log('Number of Testcases: ' + Object.keys(this.config.executionFilters.testcases).length)
        this.log()

        let fmt = this.color('error title', 'Testcases Duration: ') + this.color('error title', '%ss')
        this.log(fmt, ((Math.round(this.testcaseDuration / 100)) / 10).toFixed(2))
        this.log('==================================================================')
    }

    printSpecSuitesSummary () {
        this.log('Number of Spec Files: ' + Object.keys(this.config.executionFilters.specFiles).length)
        this.log('Number of Features: ' + Object.keys(this.config.executionFilters.features).length)
        this.log('Number of Specs: ' + Object.keys(this.config.executionFilters.specs).length)
        this.log()

        let fmt = this.color('error title', 'Specs Duration: ') + this.color('error title', '%ss')
        this.log(fmt, ((Math.round(this.stats.getSpecsDuration() / 100)) / 10).toFixed(2))
        this.log('==================================================================')
    }

    results (results, duration) {
        let fmt

        fmt = this.color('green', '%d passing') + this.color('light', ` (${results.passing.percentage}%)`)
        this.log(fmt, results.passing.count || 0)

        // pending
        if (results.skipped.count > 0) {
            fmt = this.color('pending', '%d skipped') + this.color('light', ` (${results.skipped.percentage}%)`)
            this.log(fmt, results.skipped.count)
        }

        // unvalidateds
        if (results.unvalidated.count > 0) {
            fmt = this.color('unvalidated', '%d unvalidated') + this.color('light', ` (${results.unvalidated.percentage}%)`)
            this.log(fmt, results.unvalidated.count)
        }

        // failures
        if (results.failing.count > 0) {
            fmt = this.color('fail', '%d failing') + this.color('light', ` (${results.failing.percentage}%)`)
            this.log(fmt, results.failing.count)
        }

        if (results.broken.count > 0) {
            fmt = this.color('broken', '%d broken') + this.color('light', ` (${results.broken.percentage}%)`)
            this.log(fmt, results.broken.count)
        }

        this.log('==================================================================')
    }

    storeResults (results, counts) {
        const total = 0 + counts.passes + counts.pending + counts.unvalidateds + counts.failures + counts.brokens

        if (total > 0) {
            results.passing.count = counts.passes
            results.passing.percentage = (counts.passes / total * 100).toFixed(1)
            results.skipped.count = counts.pending
            results.skipped.percentage = (counts.pending / total * 100).toFixed(1)
            results.unvalidated.count = counts.unvalidateds
            results.unvalidated.percentage = (counts.unvalidateds / total * 100).toFixed(1)
            results.failing.count = counts.failures
            results.failing.percentage = (counts.failures / total * 100).toFixed(1)
            results.broken.count = counts.brokens
            results.broken.percentage = (counts.brokens / total * 100).toFixed(1)
        } else {
            results.passing.percentage = 0
        }
    }

    getTestcaseResults () {
        this.storeResults(this.testcaseResultCounts, this.stats.getTestcaseCounts())

        return this.testcaseResultCounts
    }

    getSpecResults () {
        this.storeResults(this.specResultCounts, this.stats.getCounts())

        return this.specResultCounts
    }

    /**
     * Output common epilogue used by many of
     * the bundled reporters.
     *
     * @api public
     */
    epilogue () {
        const counts = this.stats.getCounts()
        const testcaseCounts = this.stats.getTestcaseCounts()

        if (!this.printEpilogue) {
            return
        }

        this.storeResults(this.testcaseResultCounts, testcaseCounts)
        this.storeResults(this.specResultCounts, counts)

        if (testcaseCounts.failures || testcaseCounts.brokens || testcaseCounts.unvalidateds) {
            this.listTestcaseFailures()
        }

        if (counts.failures || counts.brokens || counts.unvalidateds) {
            this.listSpecFailures()
        }

        this.log('==================================================================')

        this.printTestcaseSuitesSummary()

        this.printSpecSuitesSummary()

        this.printCoverage()

        this.log('Testcase Results:\n')

        this.results(this.testcaseResultCounts, this.testcaseDuration)

        this.log('Spec Criteria Results:\n')

        this.results(this.specResultCounts, this.stats.getSpecsDuration())

        this.printEpilogue = false
    }

    listFailures (failures, specs) {
        failures.forEach((test, i) => {
            const sfmt = this.color('error title', '%s) %s:\n')

            let title = test.printTitle

            this.log(sfmt, i + 1, title)

            const self = this

            if (test.errs && test.errs.length > 0) {
                test.errs.forEach(function (err, j) {
                    const errMessageColor = typeof err.matcherName === 'undefined' && err.stack ? 'bright yellow' : 'error message'
                    const efmt = self.color(errMessageColor, '%s') + self.color('browser', '%s') + self.color('error stack', '\n%s\n')

                    self.log(efmt, err.message, test.runningBrowser, err.stack)
                })
            } else if (test.unvalidated) {
                const efmt = this.color('unvalidated', '%s') + this.color('browser', '%s\n')

                if (test.errs && test.errs.length > 0) {
                    test.errs.forEach(function (err, j) {
                        self.log(efmt, err.message, test.runningBrowser)
                    })
                } else {
                    this.log(efmt, test.err.message, test.runningBrowser)
                }
            } else {
                // should not be used any longer7
                const errMessageColor = (!test.err.matcherName && !specs) ? 'bright yellow' : 'error message'
                const efmt = self.color(errMessageColor, '%s') + self.color('browser', '%s') + self.color('error stack', '\n%s\n')

                this.log(efmt, this.trim(test.err.message), test.runningBrowser, test.err.stack)
            }
        })
    }

    /**
     * Outut the given failures as a list
     */
    listSpecFailures () {
        this.log('==================================================================\n')
        this.log('Spec Failures: ')
        this.log()

        this.listFailures(this.stats.getFailures(), true)
    }

    listTestcaseFailures () {
        this.log('==================================================================\n')
        this.log('Testcase Failures: ')
        this.log()

        this.listFailures(this.stats.getTestcaseFailures())
    }

    printCoverage () {
        const printObject = this.config.printObject

        this.log('Criteria Coverage: ')
        this.log()
        this.log(`${printObject['Automated Criteria'].count} automated ${printObject['Automated Criteria'].percentage}`)
        this.log(`${printObject['Manual Criteria'].count} manual ${printObject['Manual Criteria'].percentage}`)
        this.log(`${printObject['Uncovered Criteria'].count} unvalidated ${printObject['Uncovered Criteria'].percentage}`)

        this.log('==================================================================')
    }

    add (reporter) {
        this.reporters.push(reporter)
    }

    // Although BaseReporter is an eventemitter, handleEvent() is called instead of emit()
    // so that every event can be propagated to attached reporters
    handleEvent (...args) {
        if (this.listeners(args[0]).length) {
            this.emit.apply(this, args)
        }

        if (this.reporters.length === 0) {
            return
        }

        for (const reporter of this.reporters) {
            /**
             * skip reporter if
             *  - he isn't an eventemitter
             *  - event is not registered
             */
            if (typeof reporter.emit !== 'function' || !reporter.listeners(args[0]).length) {
                continue
            }

            reporter.emit.apply(reporter, args)
        }
    }

    /**
     * Default color map.
     */
    get colors () {
        return COLORS
    }

    /**
     * Default symbol map.
     */
    get symbols () {
        /**
         * With node.js on Windows: use symbols available in terminal default fonts
         */
        if (process.platform === 'win32') {
            return SYMBOLS_WIN
        }

        return SYMBOLS
    }
}

/**
 * Expose some basic cursor interactions
 * that are common among reporters.
 */
class Cursor {
    hide () {
        ISATTY && process.stdout.write('\u001b[?25l')
    }

    show () {
        ISATTY && process.stdout.write('\u001b[?25h')
    }

    deleteLine () {
        ISATTY && process.stdout.write('\u001b[2K')
    }

    beginningOfLine () {
        ISATTY && process.stdout.write('\u001b[0G')
    }

    CR () {
        if (ISATTY) {
            this.deleteLine()
            this.beginningOfLine()
        } else {
            process.stdout.write('\r')
        }
    }

    get isatty () {
        return ISATTY
    }
}

export default BaseReporter
export { Cursor }
