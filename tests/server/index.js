var childProcess = require('child_process')
var fs = require('fs')
var http = require('http')
var join = require('path').join

var browserify = require('browserify')
var corsify = require('corsify')
var envify = require('envify/custom')
var finished = require('tap-finished')
var launcher = require('browser-launcher')
var request = require('request')
var tapSpec = require('tap-spec')()

var hoodieProcess

// bundle of browsertests
var bundle = browserify(join(__dirname, '..', 'unit', 'index.js'))
var output = fs.createWriteStream(join(__dirname, '..', 'www', 'tests.js'))

http.createServer(corsify(function (req, res) {
  // this server accepts tap input from the client testsuite
  // it will format it with tap-spec and exit the process
  // with the appropriate exit code
  if (req.method !== 'POST') return res.end()

  console.log('receiving test results')

  // detect when the tests ended and end process
  var stream = finished(function (results) {
    setTimeout(function () {
      res.writeHead(200)
      res.write('ok')
      res.end()
      process.exit()
    }, 0)
  })
  req.pipe(stream)

  // format tap output and write it to stdout
  req.pipe(tapSpec).pipe(process.stdout)
})).listen(1337, function () {
  console.log('listening for test results')

  bundle.transform(envify({
    TEST_RESULT_SERVER: 'http://localhost:1337/'
  }))

  bundle.bundle()
  .on('error', function (err) {
    console.log(err)
    process.exit(1)
  })
  .on('end', function () {
    console.log('browser testsuite browserified')

    request.put('http://localhost:5984/_config/admins/myadmin', {
      json: true,
      body: 'secure'
    }, function (err, res, body) {
      if (err) process.exit(1)
      console.log('couchdb admin exists')

      // starting a new hoodie app from the test folder
      hoodieProcess = childProcess.spawn(
        './bin/start.js', [
        '--db-url',
        'http://myadmin:secure@localhost:5984/',
        '--admin-password',
        '12345',
        '--loglevel',
        'error',
        '--www',
        './tests/www',
        '--port',
        '6001',
        '--admin-port',
        '6002'
      ])

      hoodieProcess.stderr.on('data', function (log) {
        console.log('hoodie app failed to start')
        // process.nextTick(process.exit.bind(null, 1))
      })

      hoodieProcess.stdout.on('data', function (log) {
        if (!/hoodie app has started/i.test(log)) return

        console.log('hoodie app started')

        launcher(function (err, launch) {
          if (err) {
            console.log(err)
            process.exit(1)
          }

          launch('http://localhost:6001', {
            headless: process.env.CI === 'true',
            browser: launch.browsers.local[0].name
          }, function (err) {
            if (err) {
              console.log(err)
              process.exit(1)
            }
          })
        })
      })

      // without piping this somewhere the above data handler won't get called
      hoodieProcess.stdout.pipe(process.stderr)
      hoodieProcess.stderr.pipe(process.stderr)
    })
  })
  .pipe(output)
})

process.on('exit', function (status) {
  if (hoodieProcess.kill) hoodieProcess.kill()

  if (status === 1) {
    process.exit(1)
  }

  if (tapSpec.failed) {
    process.exit(1)
  }
})
