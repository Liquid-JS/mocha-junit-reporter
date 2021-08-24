import Debug from 'debug'
import fs from 'fs'
import md5 from 'md5'
import mkdirp from 'mkdirp'
import mocha from 'mocha'
import createStatsCollector from 'mocha/lib/stats-collector'
import path from 'path'
import stripAnsi from 'strip-ansi'
import xml from 'xml'
const debug = Debug('mocha-junit-reporter')

// Save timer references so that times are correct even if Date is stubbed.
// See https://github.com/mochajs/mocha/issues/237
const Date = global.Date

interface ReporterOptions {
    mochaFile: string
    attachments: boolean
    antMode: boolean
    antHostname?: string
    jenkinsMode: boolean
    properties?: { [key: string]: any }
    toConsole: boolean
    rootSuiteTitle: string
    testsuitesTitle: string
    suiteTitleSeparatedBy: string
    useFullSuiteTitle?: boolean
    testCaseSwitchClassnameAndName?: boolean
    includePending?: boolean
    outputs?: boolean
}

// A subset of invalid characters as defined in http://www.w3.org/TR/xml/#charsets that can occur in e.g. stacktraces
// regex lifted from https://github.com/MylesBorins/xml-sanitizer/ (licensed MIT)
const INVALID_CHARACTERS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007f-\u0084\u0086-\u009f\uD800-\uDFFF\uFDD0-\uFDFF\uFFFF\uC008]/g // eslint-disable-line no-control-regex

function findReporterOptions(options: { reporterOptions: Partial<ReporterOptions>, [key: string]: any }): Partial<ReporterOptions> {
    debug('Checking for options in', options)
    if (!options) {
        debug('No options provided')
        return {}
    }
    if (options.reporterOptions) {
        debug('Command-line options for mocha@6+')
        return options.reporterOptions
    }
    // this is require to handle .mocharc.js files
    debug('Looking for .mocharc.js options')
    return Object.keys(options).filter((key) => key.indexOf('reporterOptions.') === 0)
        .reduce((reporterOptions, key) => {
            reporterOptions[key.substring('reporterOptions.'.length)] = options[key as keyof typeof options]
            return reporterOptions
        }, {} as { [key: string]: any })
}

function configureDefaults(options: { reporterOptions: Partial<ReporterOptions>, [key: string]: any }): ReporterOptions {
    const config = findReporterOptions(options)
    debug('options', config)
    config.mochaFile = getSetting(config.mochaFile, 'MOCHA_FILE', 'test-results.xml')
    config.attachments = getSetting(config.attachments, 'ATTACHMENTS', false)
    config.antMode = getSetting(config.antMode, 'ANT_MODE', false)
    config.jenkinsMode = getSetting(config.jenkinsMode, 'JENKINS_MODE', false)
    config.properties = getSetting(config.properties, 'PROPERTIES', undefined, parsePropertiesFromEnv)
    config.toConsole = !!config.toConsole
    config.rootSuiteTitle = config.rootSuiteTitle || 'Root Suite'
    config.testsuitesTitle = config.testsuitesTitle || 'Mocha Tests'

    if (config.antMode) {
        updateOptionsForAntMode(config)
    }

    if (config.jenkinsMode) {
        updateOptionsForJenkinsMode(config)
    }

    config.suiteTitleSeparatedBy = config.suiteTitleSeparatedBy || ' '

    return config as ReporterOptions
}

function updateOptionsForAntMode(options: Partial<ReporterOptions>) {
    options.antHostname = getSetting(options.antHostname, 'ANT_HOSTNAME', process.env.HOSTNAME)

    if (!options.properties) {
        options.properties = {}
    }
}

function updateOptionsForJenkinsMode(options: Partial<ReporterOptions>) {
    if (options.useFullSuiteTitle === undefined) {
        options.useFullSuiteTitle = true
    }
    debug('jenkins mode - testCaseSwitchClassnameAndName', options.testCaseSwitchClassnameAndName)
    if (options.testCaseSwitchClassnameAndName === undefined) {
        options.testCaseSwitchClassnameAndName = true
    }
    if (options.suiteTitleSeparatedBy === undefined) {
        options.suiteTitleSeparatedBy = '.'
    }
}

/**
 * Determine an option value.
 * 1. If `key` is present in the environment, then use the environment value
 * 2. If `value` is specified, then use that value
 * 3. Fall back to `defaultVal`
 * @module mocha-junit-reporter
 * @param {Object} value - the value from the reporter options
 * @param {String} key - the environment variable to check
 * @param {Object} defaultVal - the fallback value
 * @param {function} transform - a transformation function to be used when loading values from the environment
 */
function getSetting<T>(value: T, key: string, defaultVal?: T, transform?: (val?: string) => T) {
    if (process.env[key] !== undefined) {
        const envVal = process.env[key]
        return (typeof transform === 'function') ? transform(envVal) : envVal as any as T
    }
    if (value !== undefined) {
        return value
    }
    return defaultVal
}

function defaultSuiteTitle(this: MochaJUnitReporter, suite: mocha.Suite) {
    if (!suite.parent && suite.title === '') {
        return stripAnsi(this._options.rootSuiteTitle)
    }
    return stripAnsi(suite.title)
}

function fullSuiteTitle(this: MochaJUnitReporter, suite: mocha.Suite) {
    let parent = suite.parent
    const title = [suite.title]

    while (parent) {
        if (!parent.parent && parent.title === '') {
            title.unshift(this._options.rootSuiteTitle)
        } else {
            title.unshift(parent.title)
        }
        parent = parent.parent
    }

    return stripAnsi(title.join(this._options.suiteTitleSeparatedBy))
}

function parsePropertiesFromEnv(envValue: string | undefined) {
    if (envValue) {
        debug('Parsing from env', envValue)
        return envValue.split(',').reduce(function (properties, prop) {
            const property = prop.split(':')
            properties[property[0]] = property[1]
            return properties
        }, {} as { [key: string]: any })
    }

    return undefined
}

function generateProperties(options: ReporterOptions) {
    return Object.keys(options.properties || {}).map((name) => ({
        name,
        // tslint:disable-next-line: no-non-null-assertion
        value: options.properties![name]
    }))
}

function getJenkinsClassname(test: mocha.Test, options: ReporterOptions) {
    debug('Building jenkins classname for', test)
    let parent = test.parent
    const titles = []
    while (parent) {
        if (parent.title) titles.unshift(parent.title)
        parent = parent.parent
    }
    return titles.join(options.suiteTitleSeparatedBy)
}

declare module 'mocha' {
    interface Suite {
        '__mocha_id__': string
        id: string
    }

    interface Test {
        consoleOutputs?: string[]
        consoleErrors?: string[]
        attachments?: string[]
    }
}

/**
 * JUnit reporter for mocha.js.
 * @module mocha-junit-reporter
 * @param {EventEmitter} runner - the test runner
 * @param {Object} options - mocha options
 */
class MochaJUnitReporter extends mocha.reporters.Base {
    public _options: ReporterOptions
    private _runner: mocha.Runner
    private _generateSuiteTitle: (suite: mocha.Suite) => string
    private _antId: number
    _Date: typeof Date & { clock: { tick(val: number): void } }
    private testsuites: Map<string, ReturnType<MochaJUnitReporter['getTestsuiteData']>>
    _xml?: string
    constructor(runner: mocha.Runner, options: { reporterOptions: Partial<ReporterOptions>, [key: string]: any }) {
        super(runner)
        createStatsCollector(runner)

        this._options = configureDefaults(options)
        this._runner = runner
        this._generateSuiteTitle = this._options.useFullSuiteTitle ? fullSuiteTitle : defaultSuiteTitle
        this._antId = 0
        this._Date = (options || {}).Date || Date

        this.testsuites = new Map<string, ReturnType<MochaJUnitReporter['getTestsuiteData']>>()

        // remove old results
        this._runner.on(mocha.Runner.constants.EVENT_RUN_BEGIN, () => {
            if (fs.existsSync(this._options.mochaFile)) {
                debug('removing report file', this._options.mochaFile)
                fs.unlinkSync(this._options.mochaFile)
            }
        })

        this._runner.on(mocha.Runner.constants.EVENT_SUITE_BEGIN, (suite) => {
            this.testsuites.set(suite.id, this.getTestsuiteData(suite))
        })

        this._runner.on(mocha.Runner.constants.EVENT_SUITE_END, (suite) => this._onSuiteEnd(suite))

        this._runner.on(mocha.Runner.constants.EVENT_TEST_PASS, (test) => {
            if (test.parent)
                this.testsuites.get(test.parent?.['__mocha_id__'])?.testData.push(this.getTestcaseData(test))
        })

        this._runner.on(mocha.Runner.constants.EVENT_TEST_FAIL, (test, err) => {
            if (err) {
                debug('test fail', err)
            }
            if (test.parent)
                this.testsuites.get(test.parent?.['__mocha_id__'])?.testData.push(this.getTestcaseData(test, err))
        })

        if (this._options.includePending) {
            this._runner.on(mocha.Runner.constants.EVENT_TEST_PENDING, (test) => {
                const testcase = this.getTestcaseData(test)

                testcase.skipped = true
                if (test.parent)
                    this.testsuites.get(test.parent?.['__mocha_id__'])?.testData.push(testcase)
            })
        }

        this._runner.on(mocha.Runner.constants.EVENT_RUN_END, () => {
            this.flush(Array.from(this.testsuites.values()))
        })
    }

    get _testsuites() {
        return Array.from(this.testsuites.values())
    }

    _onSuiteEnd(suite: mocha.Suite) {
        const testsuite = this.testsuites.get(suite.id)
        if (testsuite) {
            const start = testsuite.timestamp
            testsuite.time = this._Date.now() - start
        }
    }

    getTestsuiteData(suite: mocha.Suite) {
        const antMode = this._options.antMode
        const name = this._generateSuiteTitle(suite)

        const properties = generateProperties(this._options)

        const testSuite = {
            name,
            timestamp: this._Date.now(),
            testData: new Array<ReturnType<MochaJUnitReporter['getTestcaseData']>>(),
            ...suite.file
                ? { file: suite.file }
                : {},
            ...antMode
                ? {
                    package: name,
                    // tslint:disable-next-line: no-non-null-assertion
                    hostname: this._options.antHostname!,
                    id: this._antId++,
                    errors: 0
                }
                : {},
            ... (properties.length || antMode)
                ? { properties }
                : {}
        }

        return testSuite as typeof testSuite & {
            time?: number
        }
    }

    getTestcaseData(test: mocha.Test, err?: any) {
        const jenkinsMode = this._options.jenkinsMode
        const flipClassAndName = this._options.testCaseSwitchClassnameAndName
        const name = stripAnsi(jenkinsMode ? getJenkinsClassname(test, this._options) : test.fullTitle()).trim()
        const classname = stripAnsi(test.title)

        let failure: { message: string, type: string, description?: string } | undefined
        if (err) {
            let message
            if (err.message && typeof err.message.toString === 'function') {
                message = err.message + ''
            } else if (typeof err.inspect === 'function') {
                message = err.inspect() + ''
            } else {
                message = ''
            }
            const failureMessage = err.stack || message
            failure = {
                message: this.removeInvalidCharacters(message) || '',
                type: err.operator || err.name || '',
                description: this.removeInvalidCharacters(failureMessage)
            }
        }

        // We need to merge console.logs and attachments into one <system-out> -
        //  see JUnit schema (only accepts 1 <system-out> per test).
        const systemOutLines = [
            ...this._options.outputs
                ? test.consoleOutputs || []
                : [],
            ...this._options.attachments
                ? test.attachments?.map((file) => '[[ATTACHMENT|' + file + ']]') || []
                : []
        ]
        const systemErrLines = [
            ...this._options.outputs
                ? test.consoleErrors || []
                : []
        ]

        const testcase = {
            name: flipClassAndName ? classname : name,
            time: (typeof test.duration === 'undefined') ? 0 : test.duration,
            classname: flipClassAndName ? name : classname,
            failure,
            skipped: false,
            ...systemOutLines.length
                ? {
                    systemOut: this.removeInvalidCharacters(stripAnsi(systemOutLines.join('\n')))
                }
                : {},
            ...systemErrLines.length
                ? {
                    systemErr: this.removeInvalidCharacters(stripAnsi(systemErrLines.join('\n')))
                }
                : {}
        }
        return testcase
    }

    removeInvalidCharacters(input: string | undefined) {
        if (!input) {
            return input
        }
        return input.replace(INVALID_CHARACTERS_REGEX, '')
    }

    flush(testsuites: ReturnType<MochaJUnitReporter['getTestsuiteData']>[]) {
        try {
            this._xml = this.getXml(testsuites)

            this.writeXmlToDisk(this._xml, this._options.mochaFile)

            if (this._options.toConsole === true) {
                console.log(this._xml) // eslint-disable-line no-console
            }
        } catch (err) {
            console.error(err)
        }
    }

    getXml(suites: ReturnType<MochaJUnitReporter['getTestsuiteData']>[]) {
        let totalTests = 0
        const stats = this._runner.stats
        const antMode = this._options.antMode

        let testsuites = suites
            .filter(({ testData }) => !!testData.length)
            .map(({ properties, testData, ...suite }) => {
                const suiteAttr = {
                    ...suite,
                    time: ((suite.time || 0) / 1000).toFixed(4),
                    timestamp: new this._Date(suite.timestamp).toISOString().slice(0, -5),
                    skipped: 0,
                    failures: 0,
                    tests: testData.length
                }
                const data = {
                    testsuite: [
                        {
                            _attr: suiteAttr
                        },
                        ...properties
                            ? [{
                                properties: properties.map(p => ({ property: [{ _attr: p }] } as xml.XmlObject))
                            }]
                            : [],
                        ...testData.map(({ failure, skipped, systemErr, systemOut, ...test }) => {
                            totalTests++
                            if (skipped)
                                suiteAttr.skipped++
                            if (failure)
                                suiteAttr.failures++
                            return {
                                testcase: [
                                    {
                                        _attr: {
                                            ...test,
                                            time: (test.time / 1000).toFixed(4)
                                        }
                                    },
                                    ...failure
                                        ? [{
                                            failure: {
                                                _attr: {
                                                    message: failure.message,
                                                    type: failure.type
                                                },
                                                _cdata: failure.description
                                            }
                                        }]
                                        : [],
                                    ...skipped
                                        ? [{
                                            skipped: null
                                        }]
                                        : [],
                                    ...systemOut
                                        ? [{
                                            ['system-out']: systemOut
                                        }]
                                        : [],
                                    ...systemErr
                                        ? [{
                                            ['system-err']: systemErr
                                        }]
                                        : []
                                ]
                            } as xml.XmlObject
                        }),
                        ...['system-out', 'system-err']
                            .flatMap(name => {
                                if (name in suite) {
                                    return []
                                } else if (antMode) {
                                    return [{
                                        [name]: null
                                    }]
                                }
                                return []
                            })
                    ]
                } as xml.XmlObject

                if (!suiteAttr.skipped)
                    // @ts-ignore
                    delete suiteAttr.skipped

                return data
            })

        if (!antMode) {
            const rootSuite = {
                _attr: {
                    name: this._options.testsuitesTitle,
                    time: (stats?.duration && (stats?.duration / 1000) || 0).toFixed(4),
                    tests: totalTests,
                    failures: stats?.failures || 0
                } as xml.XmlAttrs
            }
            if (stats?.pending) {
                rootSuite._attr.skipped = stats.pending
            }
            testsuites = [rootSuite as xml.XmlObject].concat(testsuites)
        }

        return xml({ testsuites: testsuites }, { declaration: true, indent: '  ' })
    }

    writeXmlToDisk(body: string, filePath: string) {
        if (filePath) {
            if (filePath.indexOf('[hash]') !== -1) {
                filePath = filePath.replace('[hash]', md5(body))
            }

            debug('writing file to', filePath)
            mkdirp.sync(path.dirname(filePath))

            try {
                fs.writeFileSync(filePath, body, 'utf-8')
            } catch (exc) {
                debug('problem writing results: ' + exc)
            }
            debug('results written successfully')
        }
    }
}
export = MochaJUnitReporter
