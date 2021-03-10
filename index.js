'use strict';

const BbPromise = require('bluebird');
const chalk = require('chalk');
const execPromise = require('./lib/execPromise');
const createMainGo = require('./lib/createMainGo');
const path = require('path');

/**
 * Default values for the serverless.yml definition.
 *
 * You can override any of these by overriding them in custom.go-build
 * @type {Object}
 */
const defaultGoDict = {
  // Prefix used for building for AWS
  awsbuildPrefix: 'GOOS=linux ',
  // Build command - followed by bin dest and input path
  buildCmd: `go build -ldflags="-s -w" -o %2 %1`,
  // Test command - followed by value in tests array below
  testCmd: `stage=testing GO_TEST=serverless go test -v %1`,
  // Path to store build results
  binPath: 'bin',
  // Runtime to require
  runtime: "go1.x",
  // The path to aws-lambda-go/lambda - autogenerated include in main.go
  // (needed when referring to module/PubFunction)
  pathToAWSLambda: "github.com/aws/aws-lambda-go/lambda",
  // Path to put generated main.go files (module/PubFunction)
  generatedMainPath: "generatedEntrypoints",
  // Location of go path - needed for (module/PubFunction)
  // Must point fully to the /src segment of the path
  // (By default pulls it from $GOPATH)
  goPath: undefined,
  // Pass this to minimize the package uploaded to just the binary
  // for that endpoint
  minimizePackage: true,
  // Test plugins to start before running 
  testPlugins: [],
  // Delay in milliseconds between starting plugins and starting tests
  testStartDelay: 0,
  // Array of tests to run
  tests: [],
}

function format(str, arr) {
  return str.replace(/%(\d+)/g, function(_,m) {
    return arr[--m];
  });
}

class TerminateOnTestFinishSuccess extends Error {
  constructor(commands) {
    const message = `Tests completed successfully  - terminating`;

    super(message);
    this.message = message;
    this.name = 'Tests Successful';
  }
}

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.commands = {
      build: {
        usage: 'Builds your go files needed for deployment',
        lifecycleEvents: [
          'build',
        ],
        options: {
          local: {
            usage:
              'Not yet active: If the build should be made for the local machine (otherwise defaults to AWS deployment)',
            shortcut: 'l',
          },
        },
      },
      test: {
        usage: 'Runs your go tests',
        lifecycleEvents: [
          'test',
        ],
      },
    };

    this.hooks = {
      'before:build:build': this.createMains.bind(this),
      'build:build': this.build.bind(this),
      'test:test': this.tests.bind(this),
      'before:deploy:function:packageFunction': this.predeploy.bind(this),
      'before:package:createDeploymentArtifacts': this.predeploy.bind(this),
    };
  }

  /**
   * Gets go-build configuation parameter from serverless.yml - or default
   * @param  {string} param -- Key to get - must be defined in defaultGoDict
   * @return {object}
   */
  getGoConfigParam(param) {
    try {
      const val = this.serverless.service.custom['go-build'][param]
      return val !== undefined ? val : defaultGoDict[param]
    }
    catch (err) {
      return defaultGoDict[param]
    }
  }

  /**
   * Gets all functions for building.
   *
   * This filters out functions from the wrong runtime, or returns only a single
   * function in the case that a specific function was passed in at runtime
   * 
   * @return {list(objects)} List of functions, objects defined by serverless
   */
  getRelevantGoFunctions() {
    let functionNames;
    
    if (this.options.function) {
      functionNames = [this.options.function];
    } else {
      // Get all functions just gets names - not full object
      functionNames = this.serverless.service.getAllFunctions()
    }

    // Retrieve the full objects
    const rawFunctions = functionNames.map((func) => this.serverless.service.getFunction(func))

    const functions = this.getGoConfigParam("useBinPathForHandler") === true ? rawFunctions.map(func => ({
      ...func,
      handler: func.handler.substring(this.getGoConfigParam("binPath").length + 1) + '.go'
    })) : rawFunctions

    // 
    // Filter out functions that are not the expected runtime
    // 

    // Get the runtime we are expecting a function to have
    const runtime = this.getGoConfigParam('runtime')

    // First determine if project default is golang
    const isProjectGolang = this.serverless.service.provider.runtime === runtime

    let isFileGolangFunc;
    if (isProjectGolang) {
      isFileGolangFunc = f => !f.runtime || f.runtime === runtime
    } else {
      isFileGolangFunc = f => f.runtime && f.runtime === runtime
    }

    const goFunctions = functions.filter(isFileGolangFunc)

    return goFunctions
  }

  /**
   * Get the destination binary path for a given function
   * @param  {object} func -- Serverless function object
   * @return {string}      -- Path of binary
   */
  getOutputBin(func) {
      let outputbin = func.handler.replace(/\.go$/, "")
      const binPath = this.getGoConfigParam('binPath')
      outputbin = path.join(binPath, outputbin)
      return outputbin
  }


  /**
   * Path to GO root
   * Gets it from optional field goPath, otherwise ENV variable GOPATH
   * @return {string} GOPATH to source
   */
  getGoPath() {
    const goPath = this.getGoConfigParam('goPath')
    return goPath ? goPath : `${process.env.GOPATH}/src/`
  }

  /**
   * Find functions needing generated main paths
   * @param  {object} func Serverless function object
   * @return {object}     
   *      func {object} (same as passed in)
   *      publicFunctionName Public Function
   *      modulePath         Path to module
   *      moduleName         Name of module
   *      mainPath           Path to place the created main.go file

   */
  getFunctionNeedingMain(func) {

    if (!func || !func.handler) {
      return null
    }
    // Which is the public function that should be run
    // Match the "file extension" part of the path
    const matchedFunc = func.handler.match(/(.*?)\.([^\.]*)$/)
    if (!matchedFunc) {
      return null
    }

    const modulePath = matchedFunc[1]
    const publicFunctionName = matchedFunc[2]

    // If a .go - it's not a function needing a generated main
    // (It's a .go file...)
    if (publicFunctionName === "go") {
      return null
    }

    // Get filename from the modulePath
    const mainBasePath = this.getGoConfigParam('generatedMainPath')
    // Get module name by replacing everything in the leading path (TODO: switch to library)
    const moduleName   = modulePath.replace(/^.*[\\\/]/, '')
    // Generate full path to generated go file
    const mainPath     = path.join(mainBasePath, modulePath, publicFunctionName, "main.go")

    return {
      func, 
      publicFunctionName,
      modulePath,
      moduleName,
      mainPath,
    }
  }

  /**
   * Create main go files if pointing towards a package
   */
  createMains() {
    const functions = this.getRelevantGoFunctions();

    // Get all functions that need main
    const foundFunctions = []
    for (const func of functions) {
      const funcNeedingMain = this.getFunctionNeedingMain(func);
      if (funcNeedingMain) {
        foundFunctions.push(funcNeedingMain)
      }
    }

    // Exit early if none found
    if (!foundFunctions.length) {
      return
    }

    this.serverless.cli.log('Creating main functions for modules');
    return BbPromise.mapSeries(foundFunctions, funcMap => {

      const goPath = this.getGoPath()
      const fullModulePath = `${this.serverless.config.servicePath}/${funcMap.modulePath}`

      if (!fullModulePath.startsWith(goPath)){
        // Couldn't build file - output appropriate errors
        console.log(chalk.red(`"Module path not in GOPATH - set gopath in serverless if needed"`));
        throw Error("Module path not in GOPATH - set gopath in serverless if needed")
      }

      // Variables needed to generated main file
      const outPath      = path.join(this.serverless.config.servicePath, funcMap.mainPath)
      const moduleName   = funcMap.moduleName
      const modulePath   = fullModulePath.substr(goPath.length)
      const pubFunc      = funcMap.publicFunctionName
      const pathToLambda = this.getGoConfigParam('pathToAWSLambda')

      return createMainGo(outPath, modulePath, moduleName, pubFunc, pathToLambda).catch(err => {
        // Couldn't build file - output appropriate errors
        console.log(err)
        throw Error("Go build failure")
      })
    });
  }

  /**
   * Run the build on all relevant files
   * @return {BbPromise}
   */
  build() {
    this.serverless.cli.log('Beginning Go build');

    // Run build on relevant go functions
    const functions = this.getRelevantGoFunctions();

    return BbPromise.mapSeries(functions, (func, idx) => {

      const funcNeedingMain = this.getFunctionNeedingMain(func);
      const mainPath = funcNeedingMain ? funcNeedingMain.mainPath : func.handler;

      // Construct the build command
      const awsbuildPrefix = this.getGoConfigParam('awsbuildPrefix')
      const buildPrefix = awsbuildPrefix + this.getGoConfigParam('buildCmd')
      const buildCmd = format(buildPrefix, [mainPath, this.getOutputBin(func)]);

      // Log the build command being run
      this.serverless.cli.log(buildCmd);

      // Return a promise executing the build command
      return execPromise(buildCmd).catch(err => {
        // Couldn't build file - output appropriate errors
        console.log(chalk.red(`Error building golang file at ${func.handler}\n` + 
                              `To replicate please run:\n` + 
                              `${buildCmd}\n`));
        throw Error("Go build failure")
      });
    });
  }

  /**
   * Run tests
   * @return {BbPromise}
   */
  tests() {
    this.serverless.cli.log('Running Go tests')

    const tests = this.getGoConfigParam('tests')

    if (!tests.length) {
      console.log(chalk.red('No tests to run - add tests to custom.go-build.tests in your serverless file.'))
    }

    const testPlugins = this.getGoConfigParam('testPlugins')
    const testStartDelay = this.getGoConfigParam('testStartDelay')

    return BbPromise.mapSeries(testPlugins, plugin => {
      return this.serverless.pluginManager.spawn(
        plugin, { terminateLifecycleAfterExecution: false });
    })
    .delay(testStartDelay)
    .then(result => {
      return BbPromise.mapSeries(tests, test => {
        // Construct the test command
        const testPrefix = this.getGoConfigParam('testCmd')
        const testCmd = format(testPrefix, [test])

        // Return a promise executing the build command
        return execPromise(testCmd).catch(err => {
          // Couldn't build file - output appropriate errors
          console.log(chalk.red(`Error running test on ${test}\n` + 
                                `To replicate please run:\n` + 
                                `${testCmd}\n`));
          throw Error("Go test failure")
        });
      });
    })
    .then(result => {

      this.serverless.cli.log(`Tests successfully exited`);
      // Unfortunately there does not seem to be a clean way
      // to quit out of serverless without throwing an error
      // and thus returning a non-zero response which is 
      // unacceptable when running tests.
      // Simply exit the process with a success.
      // Re-add the BbPromise reject for a slightly cleaner exit
      process.exit(0)
      // return BbPromise.reject(new TerminateOnTestFinishSuccess())
    })
  }

  /**
   * Before packaging functions must be redirected to point at the binary built
   */
  predeploy() {
    this.serverless.cli.log(`Reassigning go paths to point to ${this.getGoConfigParam('binPath')}`);

    const functions = this.getRelevantGoFunctions();
    for (const func of functions) {
      func.handler = this.getOutputBin(func)
      if (this.getGoConfigParam('minimizePackage') && !func.package) {
        func.package = {
          exclude: [`./**`],
          include: [`./${func.handler}`],
        }
      }
    }
  }
}

module.exports = ServerlessPlugin;
