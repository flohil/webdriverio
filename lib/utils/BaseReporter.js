import tty from 'tty'
import events from 'events'
import supportsColor from 'supports-color'
import sanitize from '../helpers/sanitize'
import { ReporterStats } from './ReporterStats'

const ISATTY = tty.isatty(1) && tty.isatty(2)

const COLORS = {
    'pass': 90,
    'fail': 31,
    'bright pass': 92,
    'bright fail': 91,
    'bright yellow': 93,
    'unverified': 35,
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
    'light': 90,
    'diff gutter': 90,
    'diff added': 32,
    'diff removed': 31
}

const SYMBOLS_WIN = {
    ok: '\u221A',
    err: '\u00D7',
    dot: '.',
    error: 'F'
}

const SYMBOLS = {
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

        this.testcaseResults = {
            passing: {
                count: 0,
                percentage: 0
            },
            skipped: {
                count: 0,
                percentage: 0
            },
            unverified: {
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

        this.specResults = {
            passing: {
                count: 0,
                percentage: 0
            },
            skipped: {
                count: 0,
                percentage: 0
            },
            unverified: {
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

                this.currentPrintTitle = `${spec} ${test.descriptions.spec} [${criteria} - ${test.descriptions.criteria}]`
            } else {
                this.currentPrintTitle = test.id
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
        })

        this.on('test:fail', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testFail(test)
        })

        this.on('test:broken', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testBroken(test)
        })

        this.on('test:pending', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testPending(test)
        })

        this.on('test:unverified', (test) => {
            test.id = this.currentTestId
            test.printTitle = this.currentPrintTitle
            this.stats.testUnverified(test)
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
            console.log(fmt, runner.error.message)

            fmt = this.color('bright yellow', sanitize.caps(runner.capabilities))
            console.log(fmt)

            if (runner.error.stack) {
                fmt = this.color('error stack', runner.error.stack.replace(`Error: ${runner.error.message}\n`, ''))
            } else {
                fmt = this.color('error stack', '    no stack available')
            }
            console.log(fmt)
        })

        this.on('runner:end', (runner) => {
            this.stats.runnerEnd(runner)
        })

        this.on('end', (args) => {
            this.stats.complete()
            this.printEpilogue = this.printEpilogue && !args.sigint
        })
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
        if (!supportsColor) return String(str)
        return `\u001b[${COLORS[type]}m${str}\u001b[0m`
    }

    limit (val) {
        return sanitize.limit(val)
    }

    printTestcaseSuitesSummary () {
        console.log('Number of Testcase Files: ' + Object.keys(this.config.executionFilters.testcaseFiles).length)
        console.log('Number of Suites: ' + Object.keys(this.config.executionFilters.suites).length)
        console.log('Number of Testcases: ' + Object.keys(this.config.executionFilters.testcases).length)
        console.log()

        let fmt = this.color('error title', 'Testcases Duration: ') + this.color('error title', '%ss')
        console.log(fmt, ((Math.round(this.testcaseDuration / 100)) / 10).toFixed(2))
        console.log('==================================================================')
    }

    printSpecSuitesSummary () {
        console.log('Number of Spec Files: ' + Object.keys(this.config.executionFilters.specFiles).length)
        console.log('Number of Features: ' + Object.keys(this.config.executionFilters.features).length)
        console.log('Number of Specs: ' + Object.keys(this.config.executionFilters.specs).length)
        console.log()

        let fmt = this.color('error title', 'Specs Duration: ') + this.color('error title', '%ss')
        console.log(fmt, ((Math.round(this.stats.getSpecsDuration() / 100)) / 10).toFixed(2))
        console.log('==================================================================')
    }

    results (results, duration) {
        let fmt

        fmt = this.color('green', '%d passing') + this.color('light', ` (${results.passing.percentage}%)`)
        console.log(fmt, results.passing.count || 0)

        // pending
        if (results.skipped.count > 0) {
            fmt = this.color('pending', '%d skipped') + this.color('light', ` (${results.skipped.percentage}%)`)
            console.log(fmt, results.skipped.count)
        }

        // unverifieds
        if (results.unverified.count > 0) {
            fmt = this.color('unverified', '%d unverified') + this.color('light', ` (${results.unverified.percentage}%)`)
            console.log(fmt, results.unverified.count)
        }

        // failures
        if (results.failing.count > 0) {
            fmt = this.color('fail', '%d failing') + this.color('light', ` (${results.failing.percentage}%)`)
            console.log(fmt, results.failing.count)
        }

        if (results.broken.count > 0) {
            fmt = this.color('broken', '%d broken') + this.color('light', ` (${results.broken.percentage}%)`)
            console.log(fmt, results.broken.count)
        }

        console.log('==================================================================')
    }

    storeResults (results, counts) {
        const total = 0 + counts.passes + counts.pending + counts.unverifieds + counts.failures + counts.brokens

        if (total > 0) {
            results.passing.count = counts.passes
            results.passing.percentage = (counts.passes / total * 100).toFixed(1)
            results.skipped.count = counts.pending
            results.skipped.percentage = (counts.pending / total * 100).toFixed(1)
            results.unverified.count = counts.unverifieds
            results.unverified.percentage = (counts.unverifieds / total * 100).toFixed(1)
            results.failing.count = counts.failures
            results.failing.percentage = (counts.failures / total * 100).toFixed(1)
            results.broken.count = counts.brokens
            results.broken.percentage = (counts.brokens / total * 100).toFixed(1)
        } else {
            results.passing.percentage = 0
        }
    }

    getTestcaseResults () {
        this.storeResults(this.testcaseResults, this.stats.getTestcaseCounts())

        return this.testcaseResults
    }

    getSpecResults () {
        this.storeResults(this.specResults, this.stats.getCounts())

        return this.specResults
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

        this.storeResults(this.testcaseResults, testcaseCounts)
        this.storeResults(this.specResults, counts)

        if (testcaseCounts.failures || testcaseCounts.brokens || testcaseCounts.unverifieds) {
            this.listTestcaseFailures()
        }

        if (counts.failures || counts.brokens || counts.unverifieds) {
            this.listSpecFailures()
        }

        console.log('==================================================================')

        this.printTestcaseSuitesSummary()

        this.printSpecSuitesSummary()

        this.printCoverage()

        console.log('Testcase Results:\n')

        this.results(this.testcaseResults, this.testcaseDuration)

        console.log('Spec Criteria Results:\n')

        this.results(this.specResults, this.stats.getSpecsDuration())

        this.printEpilogue = false
    }

    listFailures (failures, specs) {
        failures.forEach((test, i) => {
            const sfmt = this.color('error title', '%s) %s:\n')

            let title = test.printTitle

            console.log(sfmt, i + 1, title)

            const self = this

            if (test.errs && test.errs.length > 0) {
                test.errs.forEach(function (err, j) {
                    const errMessageColor = typeof err.matcherName === 'undefined' ? 'bright yellow' : 'error message'
                    const efmt = self.color(errMessageColor, '%s') + self.color('browser', '%s') + self.color('error stack', '\n%s\n')

                    console.log(efmt, err.message, test.runningBrowser, err.stack)
                })
            } else if (test.unverified) {
                const efmt = this.color('unverified', '%s') + this.color('browser', '%s\n')

                if (test.errs && test.errs.length > 0) {
                    test.errs.forEach(function (err, j) {
                        console.log(efmt, err.message, test.runningBrowser)
                    })
                } else {
                    console.log(efmt, test.err.message, test.runningBrowser)
                }
            } else {
                // should not be used any longer7
                const errMessageColor = (!test.err.matcherName && !specs) ? 'bright yellow' : 'error message'
                const efmt = self.color(errMessageColor, '%s') + self.color('browser', '%s') + self.color('error stack', '\n%s\n')

                console.log(efmt, this.trim(test.err.message), test.runningBrowser, test.err.stack)
            }
        })
    }

    /**
     * Outut the given failures as a list
     */
    listSpecFailures () {
        console.log('==================================================================\n')
        console.log('Spec Failures: ')
        console.log()

        this.listFailures(this.stats.getFailures(), true)
    }

    listTestcaseFailures () {
        console.log('==================================================================\n')
        console.log('Testcase Failures: ')
        console.log()

        this.listFailures(this.stats.getTestcaseFailures())
    }

    printCoverage () {
        const printObject = this.config.printObject

        console.log('Criteria Coverage: ')
        console.log()
        console.log(`${printObject['Automated Criteria'].count} automated ${printObject['Automated Criteria'].percentage}`)
        console.log(`${printObject['Manual Criteria'].count} manual ${printObject['Manual Criteria'].percentage}`)
        console.log(`${printObject['Uncovered Criteria'].count} unverified ${printObject['Uncovered Criteria'].percentage}`)

        console.log('==================================================================')
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
