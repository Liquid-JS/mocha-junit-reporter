import FakeTimer from '@sinonjs/fake-timers'
import chai from 'chai'
import chaiXML from 'chai-xml'
import fs from 'fs'
import Mocha, { ReporterConstructor, Runner, Suite, Test } from 'mocha'
import path from 'path'
import rimraf from 'rimraf'
import testConsole from 'test-console'
// @ts-ignore
import xmllint from 'xmllint'
import Reporter from '../index'
import mockXml from './mock-results'

const expect = chai.expect

const debug = require('debug')('mocha-junit-reporter:tests')

chai.use(chaiXML)

describe('mocha-junit-reporter', () => {
    let filePath: string | undefined
    let MOCHA_FILE: string | undefined
    let stdout: testConsole.Inspector

    function mockStdout() {
        stdout = testConsole.stdout.inspect()
        return stdout
    }

    function createTest(name: string, options?: any, fn?: ((done: (err?: any) => void) => void) | null) {
        options = options || {}

        // null fn means no callback which mocha treats as pending test.
        // undefined fn means caller wants a default fn.
        if (fn === undefined) {
            fn = () => { }
        }

        const test = new Test(name, fn || undefined)

        const duration = options.duration
        if (duration != null) {
            // mock duration so we have consistent output
            Object.defineProperty(test, 'duration', {
                set: () => { },
                get: () => duration
            })
        }

        return test
    }

    function runTests(reporter: Reporter, options: any, callback: () => void) {
        options = options || {}
        options.invalidChar = options.invalidChar || ''
        options.title = options.title || 'Foo Bar'

        const runner = reporter.runner
        const rootSuite = runner.suite

        const suite1 = Suite.create(rootSuite, options.title)
        suite1.addTest(createTest('can weez the juice', {
            duration: 101
        }))

        suite1.addTest(createTest('can narfle the garthog', { duration: 2002 }, (done) => {
            const err = new Error(options.invalidChar + 'expected garthog to be dead' + options.invalidChar)
            err.stack = 'this is where the stack would be'
            done(err)
        }))

        suite1.addTest(createTest('can behave like a flandip', { duration: 30003 }, (done) => {
            const err = new Error('expected baz to be masher, a hustler, an uninvited grasper of cone')
            err.name = 'BazError'
            err.stack = 'stack'
            done(err)
        }))

        const suite2 = Suite.create(rootSuite, 'Another suite!')
        suite2.addTest(createTest('works', { duration: 400004 }))

        if (options.includePending) {
            const pendingSuite = Suite.create(rootSuite, 'Pending suite!')
            pendingSuite.addTest(createTest('pending', undefined, null))
        }

        const _onSuiteEnd = reporter._onSuiteEnd.bind(reporter)

        reporter._onSuiteEnd = (suite) => {
            if (suite === rootSuite) {
                // root suite took no time to execute
                reporter._Date.clock.tick(0)
            } else if (suite === suite1) {
                // suite1 took an arbitrary amount of time that includes time to run each test + setup and teardown
                reporter._Date.clock.tick(100001)
            } else if (suite === suite2) {
                reporter._Date.clock.tick(400005)
            }

            return _onSuiteEnd(suite)
        }

        runRunner(runner, callback)
    }

    function assertXmlEquals(actual: string, expected: string) {
        expect(actual).xml.to.be.valid()
        expect(actual).xml.to.equal(expected)
    }

    function verifyMochaFile(runner: Mocha.Runner, targetPath?: string, options?: any) {
        const now = (new Date()).toISOString()
        debug('verify', now)
        const output = targetPath
            ? fs.readFileSync(targetPath, 'utf-8')
            : ''
        assertXmlEquals(output, mockXml(runner.stats, options))
        debug('done', now)
    }

    function removeTestPath(callback: (err?: any) => void) {
        rimraf(__dirname + '/output', function (err) {
            if (err) {
                return callback(err)
            }

            // tests that exercise defaults will write to $CWD/test-results.xml
            rimraf(__dirname + '/../test-results.xml', callback)
        })
    }

    function createRunner() {
        // mocha always has a root suite
        const rootSuite = new Suite('')

        // We don't want Mocha to emit timeout errors.
        // If we want to simulate errors, we'll emit them ourselves.
        rootSuite.timeout(Number.MAX_SAFE_INTEGER)

        return new Runner(rootSuite, false)
    }

    function createReporter(options?: any): Reporter {
        options = options || {}
        filePath = path.join(path.dirname(__dirname), options.mochaFile || '')

        const mocha = new Mocha({
            reporter: Reporter as ReporterConstructor,
            allowUncaught: true
        })

        return new mocha['_reporter'](createRunner(), {
            reporterOptions: options,
            Date: FakeTimer.createClock(0).Date
        })
    }

    function runRunner(runner: Mocha.Runner, callback: (err?: any) => void) {
        runner.run(function (failureCount) {
            // Ensure uncaught exception handlers are cleared before we execute test assertions.
            // Otherwise, this runner would intercept uncaught exceptions that were already handled by the mocha instance
            // running our tests.
            runner.dispose()

            callback(failureCount)
        })
    }

    function getFileNameWithHash(targetPath: string) {
        const filenames = fs.readdirSync(targetPath)
        const expected = /(^results\.)([a-f0-9]{32})(\.xml)$/i

        for (let i = 0; i < filenames.length; i++) {
            if (expected.test(filenames[i])) {
                return filenames[i]
            }
        }
    }

    before((done) => {
        // cache this
        MOCHA_FILE = process.env.MOCHA_FILE

        removeTestPath(done)
    })

    after(() => {
        // reset this
        process.env.MOCHA_FILE = MOCHA_FILE
    })

    beforeEach(() => {
        filePath = undefined
        delete process.env.MOCHA_FILE
        delete process.env.PROPERTIES
    })

    afterEach((done) => {
        debug('after')
        if (stdout) {
            stdout.restore()
        }

        removeTestPath(done)
    })

    it('can produce a JUnit XML report', (done) => {
        const reporter = createReporter({ mochaFile: 'test/output/mocha.xml' })
        runTests(reporter, undefined, () => {
            verifyMochaFile(reporter.runner, filePath)
            done()
        })
    })

    it('respects `process.env.MOCHA_FILE`', (done) => {
        process.env.MOCHA_FILE = 'test/output/results.xml'
        const reporter = createReporter()
        runTests(reporter, undefined, () => {
            verifyMochaFile(reporter.runner, process.env.MOCHA_FILE)
            done()
        })
    })

    it('respects `process.env.PROPERTIES`', (done) => {
        process.env.PROPERTIES = 'CUSTOM_PROPERTY:ABC~123'
        const reporter = createReporter({ mochaFile: 'test/output/properties.xml' })
        runTests(reporter, undefined, () => {
            verifyMochaFile(reporter.runner, filePath, {
                properties: [
                    {
                        name: 'CUSTOM_PROPERTY',
                        value: 'ABC~123'
                    }
                ]
            })
            done()
        })
    })

    it('respects `--reporter-options mochaFile=`', (done) => {
        const reporter = createReporter({ mochaFile: 'test/output/results.xml' })
        runTests(reporter, undefined, () => {
            verifyMochaFile(reporter.runner, filePath)
            done()
        })
    })

    it('respects `[hash]` pattern in test results report filename', (done) => {
        const dir = 'test/output/'
        const targetPath = dir + 'results.[hash].xml'
        const reporter = createReporter({ mochaFile: targetPath })
        runTests(reporter, undefined, () => {
            verifyMochaFile(reporter.runner, dir + getFileNameWithHash(dir))
            done()
        })
    })

    it('will create intermediate directories', (done) => {
        const reporter = createReporter({ mochaFile: 'test/output/foo/mocha.xml' })
        runTests(reporter, undefined, () => {
            verifyMochaFile(reporter.runner, filePath)
            done()
        })
    })

    it('creates valid XML report for invalid message', (done) => {
        const reporter = createReporter({ mochaFile: 'test/output/mocha.xml' })
        runTests(reporter, { invalidChar: '\u001b' }, () => {
            assertXmlEquals(reporter._xml || '', mockXml(reporter.runner.stats))
            done()
        })
    })

    it('creates valid XML report even if title contains ANSI character sequences', (done) => {
        const reporter = createReporter({ mochaFile: 'test/output/mocha.xml' })
        runTests(reporter, { title: '[38;5;104m[1mFoo Bar' }, () => {
            verifyMochaFile(reporter.runner, filePath)
            done()
        })
    })

    it('outputs pending tests if "includePending" is specified', (done) => {
        const reporter = createReporter({ mochaFile: 'test/output/mocha.xml', includePending: true })
        runTests(reporter, { includePending: true }, () => {
            verifyMochaFile(reporter.runner, filePath)
            done()
        })
    })

    it('can output to the console', (done) => {
        const reporter = createReporter({ mochaFile: 'test/output/console.xml', toConsole: true })

        const _stdout = mockStdout()
        runTests(reporter, undefined, () => {
            verifyMochaFile(reporter.runner, filePath)

            const xml = _stdout.output[0]
            assertXmlEquals(xml, mockXml(reporter.runner.stats))

            done()
        })
    })

    it('properly outputs tests when error in beforeAll', (done) => {
        const reporter = createReporter()
        const rootSuite = reporter.runner.suite
        const suite1 = Suite.create(rootSuite, 'failing beforeAll')
        suite1.beforeAll('failing hook', () => {
            throw new Error('error in before')
        })
        suite1.addTest(createTest('test 1'))

        const suite2 = Suite.create(rootSuite, 'good suite')
        suite2.addTest(createTest('test 2'))

        runRunner(reporter.runner, () => {
            reporter.runner.dispose()
            expect(reporter._testsuites).to.have.lengthOf(3)
            expect(reporter._testsuites[1].name).to.equal('failing beforeAll')
            expect(reporter._testsuites[1].testData).to.have.lengthOf(1)
            expect(reporter._testsuites[1].testData[0].name).to.equal('failing beforeAll "before all" hook: failing hook for "test 1"')
            expect(reporter._testsuites[1].testData[0].failure?.message).to.equal('error in before')
            expect(reporter._testsuites[2].name).to.equal('good suite')
            expect(reporter._testsuites[2].testData).to.have.lengthOf(1)
            expect(reporter._testsuites[2].testData[0].name).to.equal('good suite test 2')
            done()
        })
    })

    describe('when "useFullSuiteTitle" option is specified', () => {
        it('generates full suite title', (done) => {
            const reporter = createReporter({ useFullSuiteTitle: true })
            runTests(reporter, undefined, () => {
                expect(suiteName(reporter._testsuites[0])).to.equal('')
                expect(suiteName(reporter._testsuites[1])).to.equal('Root Suite Foo Bar')
                expect(suiteName(reporter._testsuites[2])).to.equal('Root Suite Another suite!')
                done()
            })
        })

        it('generates full suite title separated by "suiteTitleSeparatedBy" option', (done) => {
            const reporter = createReporter({ useFullSuiteTitle: true, suiteTitleSeparatedBy: '.' })
            runTests(reporter, undefined, () => {
                expect(suiteName(reporter._testsuites[0])).to.equal('')
                expect(suiteName(reporter._testsuites[1])).to.equal('Root Suite.Foo Bar')
                expect(suiteName(reporter._testsuites[2])).to.equal('Root Suite.Another suite!')
                done()
            })
        })

        function suiteName(suite: Reporter['_testsuites'][0]) {
            return suite.name
        }
    })

    describe('when "outputs" option is specified', () => {
        it('adds output/error lines to xml report', (done) => {
            const reporter = createReporter({ outputs: true })

            const test = createTest('has outputs')
            test.consoleOutputs = ['hello', 'world']
            test.consoleErrors = ['typical diagnostic info', 'all is OK']

            const suite = Suite.create(reporter.runner.suite, 'with console output and error')
            suite.addTest(test)

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites[1].name).to.equal(suite.title)
                expect(reporter._testsuites[1].testData).to.have.length(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal(test.fullTitle().trim())
                expect(reporter._testsuites[1].testData[0]).to.have.property('systemOut', 'hello\nworld')
                expect(reporter._testsuites[1].testData[0]).to.have.property('systemErr', 'typical diagnostic info\nall is OK')

                expect(reporter._xml).to.include('<system-out>hello\nworld</system-out>')
                expect(reporter._xml).to.include('<system-err>typical diagnostic info\nall is OK</system-err>')

                done()
            })
        })

        it('does not add system-out if no outputs/errors were passed', (done) => {
            const reporter = createReporter({ outputs: true })
            const test = createTest('has outputs')
            const suite = Suite.create(reporter.runner.suite, 'with console output and error')
            suite.addTest(test)

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites[1].name).to.equal(suite.title)
                expect(reporter._testsuites[1].testData).to.have.length(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal(test.fullTitle().trim())

                expect(reporter._xml).not.to.include('<system-out>')
                expect(reporter._xml).not.to.include('<system-err>')

                done()
            })
        })

        it('does not add system-out if outputs/errors were empty', (done) => {
            const reporter = createReporter({ outputs: true })
            const test = createTest('has outputs')
            test.consoleOutputs = []
            test.consoleErrors = []

            const suite = Suite.create(reporter.runner.suite, 'with console output and error')
            suite.addTest(test)

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites[1].name).to.equal(suite.title)
                expect(reporter._testsuites[1].testData).to.have.length(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal(test.fullTitle().trim())

                expect(reporter._xml).not.to.include('<system-out>')
                expect(reporter._xml).not.to.include('<system-err>')

                done()
            })
        })
    })

    describe('when "attachments" option is specified', () => {
        it('adds attachments to xml report', (done) => {
            const targetPath = '/path/to/file'
            const reporter = createReporter({ attachments: true })
            const test = createTest('has attachment')
            test.attachments = [targetPath]

            const suite = Suite.create(reporter.runner.suite, 'with attachments')
            suite.addTest(test)

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites[1].name).to.equal(suite.title)
                expect(reporter._testsuites[1].testData).to.have.length(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal(test.fullTitle().trim())
                expect(reporter._testsuites[1].testData[0]).to.have.property('systemOut', '[[ATTACHMENT|' + targetPath + ']]')

                expect(reporter._xml).to.include('<system-out>[[ATTACHMENT|' + targetPath + ']]</system-out>')

                done()
            })
        })

        it('does not add system-out if no attachments were passed', (done) => {
            const reporter = createReporter({ attachments: true })
            const test = createTest('has attachment')

            const suite = Suite.create(reporter.runner.suite, 'with attachments')
            suite.addTest(test)

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites[1].name).to.equal(suite.title)
                expect(reporter._testsuites[1].testData).to.have.lengthOf(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal(test.fullTitle().trim())

                expect(reporter._xml).to.not.include('<system-out>')

                done()
            })
        })

        it('does not add system-out if attachments array is empty', (done) => {
            const reporter = createReporter({ attachments: true })
            const test = createTest('has attachment')
            test.attachments = []

            const suite = Suite.create(reporter.runner.suite, 'with attachments')
            suite.addTest(test)

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites[1].name).to.equal(suite.title)
                expect(reporter._testsuites[1].testData).to.have.lengthOf(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal(test.fullTitle().trim())

                expect(reporter._xml).to.not.include('<system-out>')

                done()
            })
        })

        it('includes both console outputs and attachments in XML', (done) => {
            const reporter = createReporter({ attachments: true, outputs: true })
            const test = createTest('has attachment')
            const targetPath = '/path/to/file'
            test.attachments = [targetPath]
            test.consoleOutputs = ['first console line', 'second console line']

            const suite = Suite.create(reporter.runner.suite, 'with attachments and outputs')
            suite.addTest(test)

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites[1].name).to.equal(suite.title)
                expect(reporter._testsuites[1].testData).to.have.length(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal(test.fullTitle().trim())
                expect(reporter._testsuites[1].testData[0]).to.have.property('systemOut', 'first console line\nsecond console line\n[[ATTACHMENT|' + targetPath + ']]')

                expect(reporter._xml).to.include('<system-out>first console line\nsecond console line\n[[ATTACHMENT|' + targetPath + ']]</system-out>')

                done()
            })
        })
    })

    describe('Output', () => {
        it('skips suites with empty title', (done) => {
            const reporter = createReporter()
            const suite = Suite.create(reporter.runner.suite, '')
            suite.root = false // mocha treats suites with empty title as root, so not sure this is possible
            suite.addTest(createTest('test'))

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites).to.have.lengthOf(2)
                expect(reporter._testsuites[0].name).to.equal('Root Suite')
                done()
            })
        })

        it('skips suites without testcases and suites', (done) => {
            const reporter = createReporter()
            Suite.create(reporter.runner.suite, 'empty suite')

            // mocha won't emit the `suite` event if a suite has no tests in it, so we won't even output the root suite.
            // See https://github.com/mochajs/mocha/blob/c0137eb698add08f29035467ea1dc230904f82ba/lib/runner.js#L723.
            runRunner(reporter.runner, () => {
                expect(reporter._testsuites).to.have.lengthOf(0)
                done()
            })
        })

        it('skips suites without testcases even if they have nested suites', (done) => {
            const reporter = createReporter()
            const suite1 = Suite.create(reporter.runner.suite, 'suite')
            Suite.create(suite1, 'nested suite')

            runRunner(reporter.runner, () => {
                // even though we have nested suites, there are no tests so mocha won't emit the `suite` event
                expect(reporter._testsuites).to.have.lengthOf(0)
                done()
            })
        })

        it('does not skip suites with nested tests', (done) => {
            const reporter = createReporter()
            const suite = Suite.create(reporter.runner.suite, 'nested suite')
            suite.addTest(createTest('test'))

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites).to.have.lengthOf(2)
                expect(reporter._testsuites[0].name).to.equal('Root Suite')
                expect(reporter._testsuites[1].testData).to.have.lengthOf(1)
                expect(reporter._testsuites[1].testData[0].name).to.equal('nested suite test')
                done()
            })
        })

        it('does not skip root suite', (done) => {
            const reporter = createReporter()
            reporter.runner.suite.addTest(createTest('test'))

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites).to.have.lengthOf(1)
                expect(reporter._testsuites[0].name).to.equal('Root Suite')
                expect(reporter._testsuites[0].testData).to.have.lengthOf(1)
                expect(reporter._testsuites[0].testData[0].name).to.equal('test')
                done()
            })
        })

        it('respects the `rootSuiteTitle`', (done) => {
            const name = 'The Root Suite!'
            const reporter = createReporter({ rootSuiteTitle: name })
            reporter.runner.suite.addTest(createTest('test'))

            runRunner(reporter.runner, () => {
                expect(reporter._testsuites).to.have.lengthOf(1)
                expect(reporter._testsuites[0].name).to.equal(name)
                done()
            })
        })

        it('uses "Mocha Tests" by default', (done) => {
            const reporter = createReporter()
            reporter.runner.suite.addTest(createTest('test'))

            runRunner(reporter.runner, () => {
                expect(reporter._xml).to.include('testsuites name="Mocha Tests"')
                done()
            })
        })

        it('respects the `testsuitesTitle`', (done) => {
            const title = 'SuitesTitle'
            const reporter = createReporter({ testsuitesTitle: title })
            reporter.runner.suite.addTest(createTest('test'))

            runRunner(reporter.runner, () => {
                expect(reporter._xml).to.include('testsuites name="SuitesTitle"')
                done()
            })
        })
    })

    describe('Feature "Configurable classname/name switch"', function () {
        const mockedTestCase = {
            title: 'should behave like so',
            timestamp: 123,
            tests: '1',
            failures: '0',
            time: '0.004',
            fullTitle: () => 'Super Suite ' + this.title
        } as any as Mocha.Test

        it('should generate valid testCase for testCaseSwitchClassnameAndName default', () => {
            const reporter = createReporter()
            const testCase = reporter.getTestcaseData(mockedTestCase)
            expect(testCase.name).to.equal(mockedTestCase.fullTitle())
            expect(testCase.classname).to.equal(mockedTestCase.title)
        })

        it('should generate valid testCase for testCaseSwitchClassnameAndName=false', () => {
            const reporter = createReporter({ testCaseSwitchClassnameAndName: false })
            const testCase = reporter.getTestcaseData(mockedTestCase)
            expect(testCase.name).to.equal(mockedTestCase.fullTitle())
            expect(testCase.classname).to.equal(mockedTestCase.title)
        })

        it('should generate valid testCase for testCaseSwitchClassnameAndName=true', () => {
            const reporter = createReporter({ testCaseSwitchClassnameAndName: true })
            const testCase = reporter.getTestcaseData(mockedTestCase)
            expect(testCase.name).to.equal(mockedTestCase.title)
            expect(testCase.classname).to.equal(mockedTestCase.fullTitle())
        })
    })

    describe('XML format', function () {
        it('generates Jenkins compatible XML when in jenkinsMode', (done) => {
            this.timeout(10000) // xmllint is very slow

            const reporter = createReporter({ jenkinsMode: true })
            const rootSuite = reporter.runner.suite

            const suite1 = Suite.create(rootSuite, 'Inner Suite')
            suite1.addTest(createTest('test'))

            const suite2 = Suite.create(rootSuite, 'Another Suite')
            suite2.addTest(createTest('test', undefined, d => d(new Error('failed test'))))

            runRunner(reporter.runner, () => {
                const schema = fs.readFileSync(path.join(__dirname, 'resources', 'jenkins-junit.xsd'))
                const result = xmllint.validateXML({ xml: reporter._xml, schema: schema })
                expect(result.errors).to.equal(null, JSON.stringify(reporter._xml))

                done()
            })
        })

        it('generates Ant compatible XML when in antMode', (done) => {
            this.timeout(10000) // xmllint is very slow

            const reporter = createReporter({ antMode: true })
            const rootSuite = reporter.runner.suite

            const suite1 = Suite.create(rootSuite, 'Inner Suite')
            suite1.addTest(createTest('test'))

            const suite2 = Suite.create(rootSuite, 'Another Suite')
            suite2.addTest(createTest('test', undefined, (d) => d(new Error('failed test'))))

            runRunner(reporter.runner, () => {
                const schema = fs.readFileSync(path.join(__dirname, 'resources', 'JUnit.xsd'))
                const result = xmllint.validateXML({ xml: reporter._xml, schema: schema })
                expect(result.errors).to.equal(null, JSON.stringify(reporter._xml))

                done()
            })
        })

        describe('Jenkins format', () => {
            it('generates Jenkins compatible classnames and suite name', (done) => {
                const reporter = createReporter({ jenkinsMode: true })
                const rootSuite = reporter.runner.suite

                const suite1 = Suite.create(rootSuite, 'Inner Suite')
                suite1.addTest(createTest('test'))

                const suite2 = Suite.create(suite1, 'Another Suite')
                suite2.addTest(createTest('fail test', undefined, d => d(new Error('failed test'))))

                runRunner(reporter.runner, () => {
                    expect(reporter._testsuites[0].name).to.equal('')
                    expect(reporter._testsuites[1].testData[0].name).to.equal('test')
                    expect(reporter._testsuites[1].testData[0].classname).to.equal('Inner Suite')
                    expect(reporter._testsuites[2].name).to.equal('Root Suite.Inner Suite.Another Suite')
                    expect(reporter._testsuites[2].testData[0].name).to.equal('fail test')
                    expect(reporter._testsuites[2].testData[0].classname).to.equal('Inner Suite.Another Suite')

                    done()
                })
            })
        })
    })
})
