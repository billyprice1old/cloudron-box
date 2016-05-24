'use strict';

/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var appdb = require('../../appdb.js'),
    apps = require('../../apps.js'),
    assert = require('assert'),
    path = require('path'),
    async = require('async'),
    child_process = require('child_process'),
    clientdb = require('../../clientdb.js'),
    config = require('../../config.js'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    docker = require('../../docker.js').connection,
    expect = require('expect.js'),
    fs = require('fs'),
    hock = require('hock'),
    http = require('http'),
    https = require('https'),
    js2xml = require('js2xmlparser'),
    ldap = require('../../ldap.js'),
    net = require('net'),
    nock = require('nock'),
    paths = require('../../paths.js'),
    safe = require('safetydance'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    simpleauth = require('../../simpleauth.js'),
    superagent = require('superagent'),
    taskmanager = require('../../taskmanager.js'),
    tokendb = require('../../tokendb.js'),
    url = require('url'),
    uuid = require('node-uuid'),
    _ = require('underscore');

var SERVER_URL = 'http://localhost:' + config.get('port');

// Test image information
var TEST_IMAGE_REPO = 'cloudron/test';
var TEST_IMAGE_TAG = '14.0.0';
var TEST_IMAGE = TEST_IMAGE_REPO + ':' + TEST_IMAGE_TAG;
var TEST_IMAGE_ID = child_process.execSync('docker inspect --format={{.Id}} ' + TEST_IMAGE).toString('utf8').trim();

var APP_STORE_ID = 'test', APP_ID;
var APP_LOCATION = 'appslocation';
var APP_LOCATION_2 = 'appslocationtwo';
var APP_LOCATION_NEW = 'appslocationnew';

var APP_MANIFEST = JSON.parse(fs.readFileSync(__dirname + '/../../../../test-app/CloudronManifest.json', 'utf8'));
APP_MANIFEST.dockerImage = TEST_IMAGE;

var APP_MANIFEST_1 = JSON.parse(fs.readFileSync(__dirname + '/../../../../test-app/CloudronManifest.json', 'utf8'));
APP_MANIFEST_1.dockerImage = TEST_IMAGE;
APP_MANIFEST_1.singleUser = true;

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='admin@me.com';
var USER_1_ID = null, USERNAME_1 = 'user', PASSWORD_1 = 'Foobar?1338', EMAIL_1 ='user@me.com';
var token = null; // authentication token
var token_1 = null;

var awsHostedZones = {
     HostedZones: [{
         Id: '/hostedzone/ZONEID',
         Name: 'localhost.',
         CallerReference: '305AFD59-9D73-4502-B020-F4E6F889CB30',
         ResourceRecordSetCount: 2,
         ChangeInfo: {
             Id: '/change/CKRTFJA0ANHXB',
             Status: 'INSYNC'
         }
     }],
    IsTruncated: false,
    MaxItems: '100'
 };

function startDockerProxy(interceptor, callback) {
    assert.strictEqual(typeof interceptor, 'function');

    return http.createServer(function (req, res) {
        if (interceptor(req, res)) return;

        // rejectUnauthorized should not be required but it doesn't work without it
        var options = _.extend({ }, docker.options, { method: req.method, path: req.url, headers: req.headers, rejectUnauthorized: false });
        delete options.protocol; // https module doesn't like this key
        var proto = docker.options.protocol === 'https' ? https : http;
        var dockerRequest = proto.request(options, function (dockerResponse) {
            res.writeHead(dockerResponse.statusCode, dockerResponse.headers);
            dockerResponse.on('error', console.error);
            dockerResponse.pipe(res, { end: true });
        });

        req.on('error', console.error);
        if (!req.readable) {
            dockerRequest.end();
        } else {
            req.pipe(dockerRequest, { end: true });
        }

    }).listen(5687, callback);
}

describe('Apps', function () {
    this.timeout(50000);

    var dockerProxy;
    var imageDeleted = false;
    var imageCreated = false;

    before(function (done) {
        safe.fs.unlinkSync(paths.DATA_DIR + '/INFRA_VERSION');
        child_process.execSync('docker ps -qa | xargs --no-run-if-empty docker rm -f');

        dockerProxy = startDockerProxy(function interceptor(req, res) {
            if (req.method === 'POST' && req.url === '/images/create?fromImage=' + encodeURIComponent(TEST_IMAGE_REPO) + '&tag=' + TEST_IMAGE_TAG) {
                imageCreated = true;
                res.writeHead(200);
                res.end();
                return true;
            } else if (req.method === 'DELETE' && req.url === '/images/' + TEST_IMAGE + '?force=false&noprune=false') {
                imageDeleted = true;
                res.writeHead(200);
                res.end();
                return true;
            }
            return false;
        }, done);
    });

    after(function (done) {
        // child_process.execSync('docker ps -qa | xargs --no-run-if-empty docker rm -f');
        dockerProxy.close(done);
    });


    /*
        Individual sub category setup and cleanup
    */
    function setup(done) {
        config._reset();

        process.env.CREATE_INFRA = 1;

        async.series([
            // first clear, then start server. otherwise, taskmanager spins up tasks for obsolete appIds
            database.initialize,
            database._clear,

            server.start.bind(server),
            ldap.start,
            simpleauth.start,

            function (callback) {
                var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/' + config.fqdn() + '/setup/verify?setupToken=somesetuptoken').reply(200, {});
                var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/' + config.fqdn() + '/setup/done?setupToken=somesetuptoken').reply(201, {});

                superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                       .query({ setupToken: 'somesetuptoken' })
                       .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                       .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);
                    expect(scope1.isDone()).to.be.ok();
                    expect(scope2.isDone()).to.be.ok();

                    // stash for further use
                    token = result.body.token;

                    callback();
                });
            },

            function (callback) {
                superagent.post(SERVER_URL + '/api/v1/users')
                       .query({ access_token: token })
                       .send({ username: USERNAME_1, email: EMAIL_1, invite: false })
                       .end(function (err, res) {
                    expect(res.statusCode).to.equal(201);

                    USER_1_ID = res.body.id;

                    callback(null);
                });
            },

            function (callback) {
                token_1 = tokendb.generateToken();

                // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
                tokendb.add(token_1, tokendb.PREFIX_USER + USER_1_ID, 'test-client-id',  Date.now() + 100000, '*', callback);
            },

            settings.setDnsConfig.bind(null, { provider: 'route53', accessKeyId: 'accessKeyId', secretAccessKey: 'secretAccessKey', endpoint: 'http://localhost:5353' }),
            settings.setTlsConfig.bind(null, { provider: 'caas' }),
            settings.setBackupConfig.bind(null, { provider: 'caas', token: 'BACKUP_TOKEN', bucket: 'Bucket', prefix: 'Prefix' })
        ], done);
    }

    function cleanup(done) {
        delete process.env.CREATE_INFRA;

        // db is not cleaned up here since it's too late to call it after server.stop. if called before server.stop taskmanager apptasks are unhappy :/
        async.series([
            taskmanager.stopPendingTasks,
            taskmanager.waitForPendingTasks,
            server.stop,
            ldap.stop,
            simpleauth.stop,
            config._reset,
        ], done);
    }

    describe('App API', function () {
        this.timeout(50000);

        before(setup);

        after(function (done) {
            APP_ID = null;
            cleanup(done);
        });

        it('app install fails - missing manifest', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, password: PASSWORD })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('manifest is required');
                done();
            });
        });

        it('app install fails - missing appId', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ manifest: APP_MANIFEST, password: PASSWORD })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('appStoreId is required');
                done();
            });
        });

        it('app install fails - invalid json', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send('garbage')
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('app install fails - invalid location', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: '!awesome', accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('Hostname can only contain alphanumerics and hyphen');
                done();
            });
        });

        it('app install fails - invalid location type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: 42, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('location is required');
                done();
            });
        });

        it('app install fails - reserved admin location', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: constants.ADMIN_LOCATION, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql(constants.ADMIN_LOCATION + ' is reserved');
                done();
            });
        });

        it('app install fails - reserved api location', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: constants.API_LOCATION, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql(constants.API_LOCATION + ' is reserved');
                done();
            });
        });

        it('app install fails - portBindings must be object', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: 23, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('portBindings must be an object');
                done();
            });
        });

        it('app install fails - accessRestriction is required', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: {} })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('accessRestriction is required');
                done();
            });
        });

        it('app install fails - accessRestriction type is wrong', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: {}, accessRestriction: '' })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('accessRestriction is required');
                done();
            });
        });

        it('app install fails - accessRestriction no users not allowed', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST_1, password: PASSWORD, location: APP_LOCATION, portBindings: {}, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('accessRestriction must specify one user');
                done();
            });
        });

        it('app install fails - accessRestriction too many users not allowed', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST_1, password: PASSWORD, location: APP_LOCATION, portBindings: {}, accessRestriction: { users: [ 'one', 'two' ] } })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('accessRestriction must specify one user');
                done();
            });
        });

        it('app install fails for non admin', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token_1 })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: null, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
        });

        it('app install fails due to purchase failure', function (done) {
            var fake = nock(config.apiServerOrigin()).post('/api/v1/apps/test/purchase?token=APPSTORE_TOKEN').reply(402, {});

            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: null, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(402);
                expect(fake.isDone()).to.be.ok();
                done();
            });
        });

        it('app install succeeds with purchase', function (done) {
            var fake = nock(config.apiServerOrigin()).post('/api/v1/apps/test/purchase?token=APPSTORE_TOKEN').reply(201, {});

            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: null, accessRestriction: { users: [ 'someuser' ], groups: [] } })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                expect(res.body.id).to.be.a('string');
                APP_ID = res.body.id;
                expect(fake.isDone()).to.be.ok();
                done();
            });
        });

        it('app install fails because of conflicting location', function (done) {
            var fake = nock(config.apiServerOrigin()).post('/api/v1/apps/test/purchase?token=APPSTORE_TOKEN').reply(201, {});

            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: null, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(409);
                expect(fake.isDone()).to.be.ok();
                done();
            });
        });

        it('can get app status', function (done) {
            superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.id).to.eql(APP_ID);
                expect(res.body.installationState).to.be.ok();
                done();
             });
        });

        it('cannot get invalid app status', function (done) {
            superagent.get(SERVER_URL + '/api/v1/apps/kubachi')
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
             });
        });

        it('can get all apps', function (done) {
            superagent.get(SERVER_URL + '/api/v1/apps')
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.apps).to.be.an('array');
                expect(res.body.apps[0].id).to.eql(APP_ID);
                expect(res.body.apps[0].installationState).to.be.ok();
                done();
             });
        });

        it('non admin cannot see the app due to accessRestriction', function (done) {
            superagent.get(SERVER_URL + '/api/v1/apps')
                   .query({ access_token: token_1 })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.apps).to.be.an('array');
                expect(res.body.apps.length).to.equal(0);
                done();
             });
        });

        it('cannot uninstall invalid app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/whatever/uninstall')
                .send({ password: PASSWORD })
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
            });
        });

        it('cannot uninstall app without password', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('cannot uninstall app with wrong password', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
                .send({ password: PASSWORD+PASSWORD })
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
        });

        it('non admin cannot uninstall app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
                .send({ password: PASSWORD })
                .query({ access_token: token_1 })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
        });

        it('can uninstall app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
                .send({ password: PASSWORD })
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                done();
            });
        });

        it('app install succeeds already purchased', function (done) {
            var fake = nock(config.apiServerOrigin()).post('/api/v1/apps/test/purchase?token=APPSTORE_TOKEN').reply(200, {});

            superagent.post(SERVER_URL + '/api/v1/apps/install')
                   .query({ access_token: token })
                   .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION_2, portBindings: null, accessRestriction: null })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                expect(res.body.id).to.be.a('string');
                APP_ID = res.body.id;
                expect(fake.isDone()).to.be.ok();
                done();
            });
        });

        it('app install succeeds without password but developer token', function (done) {
            var fake = nock(config.apiServerOrigin()).post('/api/v1/apps/test/purchase?token=APPSTORE_TOKEN').reply(201, {});

            settings.setDeveloperMode(true, function (error) {
                expect(error).to.be(null);

                superagent.post(SERVER_URL + '/api/v1/developer/login')
                       .send({ username: USERNAME, password: PASSWORD })
                       .end(function (error, result) {
                    expect(error).to.not.be.ok();
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.expiresAt).to.be.a('number');
                    expect(result.body.token).to.be.a('string');

                    // overwrite non dev token
                    token = result.body.token;

                    superagent.post(SERVER_URL + '/api/v1/apps/install')
                           .query({ access_token: token })
                           .send({ appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, location: APP_LOCATION+APP_LOCATION, portBindings: null, accessRestriction: null })
                           .end(function (err, res) {
                        expect(res.statusCode).to.equal(202);
                        expect(res.body.id).to.be.a('string');
                        expect(fake.isDone()).to.be.ok();
                        APP_ID = res.body.id;
                        done();
                    });
                });
            });
        });

        it('can uninstall app without password but developer token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                done();
            });
        });
    });

    describe('App installation', function () {
        this.timeout(50000);

        var apiHockInstance = hock.createHock({ throwOnUnmatched: false }), apiHockServer;
        var awsHockInstance = hock.createHock({ throwOnUnmatched: false }), awsHockServer;

        before(function (done) {
            APP_ID = uuid.v4();

            imageDeleted = false;
            imageCreated = false;

            async.series([
                setup,

                function (callback) {
                    apiHockInstance
                        .get('/api/v1/apps/' + APP_STORE_ID + '/versions/' + APP_MANIFEST.version + '/icon')
                        .replyWithFile(200, path.resolve(__dirname, '../../../webadmin/src/img/appicon_fallback.png'));

                    var port = parseInt(url.parse(config.apiServerOrigin()).port, 10);
                    apiHockServer = http.createServer(apiHockInstance.handler).listen(port, callback);
                },

                function (callback) {
                    awsHockInstance
                        .get('/2013-04-01/hostedzone')
                        .max(Infinity)
                        .reply(200, js2xml('ListHostedZonesResponse', awsHostedZones, { arrayMap: { HostedZones: 'HostedZone'} }), { 'Content-Type': 'application/xml' })
                        .filteringRequestBody(function (unusedBody) { return ''; }) // strip out body
                        .post('/2013-04-01/hostedzone/ZONEID/rrset/')
                        .max(Infinity)
                        .reply(200, js2xml('ChangeResourceRecordSetsResponse', { ChangeInfo: { Id: 'dnsrecordid', Status: 'INSYNC' } }), { 'Content-Type': 'application/xml' });

                    awsHockServer = http.createServer(awsHockInstance.handler).listen(5353, callback);
                }
            ], done);
        });

        after(function (done) {
            APP_ID = null;

            async.series([
                cleanup,
                apiHockServer.close.bind(apiHockServer),
                awsHockServer.close.bind(awsHockServer)
            ], done);
        });

        var appResult = null /* the json response */, appEntry = null /* entry from database */;

        it('can install test app', function (done) {
            console.log('This test can take ~30 seconds to start as it waits for infra to be ready');

            var fake = nock(config.apiServerOrigin()).post('/api/v1/apps/test/purchase?token=APPSTORE_TOKEN').reply(201, {});

            var count = 0;
            function checkInstallStatus() {
                superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
                   .query({ access_token: token })
                   .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    if (res.body.installationState === appdb.ISTATE_INSTALLED) { appResult = res.body; return done(null); }
                    if (res.body.installationState === appdb.ISTATE_ERROR) return done(new Error('Install error'));
                    if (++count > 50) return done(new Error('Timedout'));
                    setTimeout(checkInstallStatus, 1000);
                });
            }

            superagent.post(SERVER_URL + '/api/v1/apps/install')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: null, accessRestriction: null })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                expect(fake.isDone()).to.be.ok();
                expect(res.body.id).to.be.a('string');
                expect(res.body.id).to.be.eql(APP_ID);
                checkInstallStatus();
            });
        });

        it('installation - image created', function (done) {
            expect(imageCreated).to.be.ok();
            done();
        });

        it('installation - can get app', function (done) {
            apps.get(appResult.id, function (error, app) {
                expect(!error).to.be.ok();
                expect(app).to.be.an('object');
                appEntry = app;
                done();
            });
        });

        it('installation - container created', function (done) {
            expect(appResult.containerId).to.be(undefined);
            docker.getContainer(appEntry.containerId).inspect(function (error, data) {
                expect(error).to.not.be.ok();
                expect(data.Config.ExposedPorts['7777/tcp']).to.eql({ });
                expect(data.Config.Env).to.contain('WEBADMIN_ORIGIN=' + config.adminOrigin());
                expect(data.Config.Env).to.contain('API_ORIGIN=' + config.adminOrigin());
                expect(data.Config.Env).to.contain('CLOUDRON=1');
                expect(data.Config.Env).to.contain('APP_ORIGIN=https://' + config.appFqdn(APP_LOCATION));
                expect(data.Config.Env).to.contain('APP_DOMAIN=' + config.appFqdn(APP_LOCATION));
                expect(data.Config.Hostname).to.be(APP_LOCATION);
                done();
            });
        });

        it('installation - nginx config', function (done) {
            expect(fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP_LOCATION + '.conf'));
            done();
        });

        it('installation - registered subdomain', function (done) {
            // this is checked in unregister subdomain testcase
            done();
        });

        it('installation - volume created', function (done) {
            expect(fs.existsSync(paths.DATA_DIR + '/' + APP_ID));
            done();
        });

        it('installation - is up and running', function (done) {
            expect(appResult.httpPort).to.be(undefined);
            setTimeout(function () {
                superagent.get('http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath)
                    .end(function (err, res) {
                    expect(!err).to.be.ok();
                    expect(res.statusCode).to.equal(200);
                    done();
                });
            }, 2000); // give some time for docker to settle
        });

        it('installation - running container has volume mounted', function (done) {
            docker.getContainer(appEntry.containerId).inspect(function (error, data) {
                expect(error).to.not.be.ok();

                // support newer docker versions
                if (data.Volumes) {
                    expect(data.Volumes['/app/data']).to.eql(paths.DATA_DIR + '/' + APP_ID + '/data');
                } else {
                    expect(data.Mounts.filter(function (mount) { return mount.Destination === '/app/data'; })[0].Source).to.eql(paths.DATA_DIR + '/' + APP_ID + '/data');
                }

                done();
            });
        });

        it('installation - app responnds to http request', function (done) {
            superagent.get('http://localhost:' + appEntry.httpPort).end(function (err, res) {
                expect(!err).to.be.ok();
                expect(res.statusCode).to.equal(200);
                expect(res.body.status).to.be('OK');
                done();
            });
        });

        it('installation - oauth addon config', function (done) {
            var appContainer = docker.getContainer(appEntry.containerId);
            appContainer.inspect(function (error, data) {
                expect(error).to.not.be.ok();

                clientdb.getByAppIdAndType(APP_ID, clientdb.TYPE_OAUTH, function (error, client) {
                    expect(error).to.not.be.ok();
                    expect(client.id.length).to.be(40); // cid- + 32 hex chars (128 bits) + 4 hyphens
                    expect(client.clientSecret.length).to.be(64); // 32 hex chars (256 bits)
                    expect(data.Config.Env).to.contain('OAUTH_CLIENT_ID=' + client.id);
                    expect(data.Config.Env).to.contain('OAUTH_CLIENT_SECRET=' + client.clientSecret);
                    done();
                });
            });
        });

        it('installation - app can populate addons', function (done) {
            superagent.get('http://localhost:' + appEntry.httpPort + '/populate_addons').end(function (err, res) {
                expect(!err).to.be.ok();
                expect(res.statusCode).to.equal(200);
                for (var key in res.body) {
                    expect(res.body[key]).to.be('OK');
                }
                done();
            });
        });

        it('installation - app can check addons', function (done) {
            async.retry({ times: 100, interval: 5000 }, function (callback) {
                superagent.get('http://localhost:' + appEntry.httpPort + '/check_addons')
                    .query({ username: USERNAME, password: PASSWORD })
                    .end(function (err, res) {

                    expect(!err).to.be.ok();
                    expect(res.statusCode).to.equal(200);

                    delete res.body.sendmail; // sendmail auth fails
                    delete res.body.recvmail; // dovecot mail delivery won't work
                    delete res.body.stdenv; // cannot access APP_ORIGIN

                    for (var key in res.body) {
                        if (res.body[key] !== 'OK') return callback('Not done yet');
                    }

                    callback();
                });
            }, done);
        });

        var redisIp, exportedRedisPort;

        it('installation - redis addon created', function (done) {
            docker.getContainer('redis-' + APP_ID).inspect(function (error, data) {
                expect(error).to.not.be.ok();
                expect(data).to.be.ok();

                redisIp = safe.query(data, 'NetworkSettings.IPAddress');
                expect(redisIp).to.be.ok();

                exportedRedisPort = safe.query(data, 'NetworkSettings.Ports.6379/tcp[0].HostPort');
                expect(exportedRedisPort).to.be.ok();

                done();
            });
        });

        xit('logs - stdout and stderr', function (done) {
            superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID + '/logs')
                .query({ access_token: token })
                .end(function (err, res) {
                var data = '';
                res.on('data', function (d) { data += d.toString('utf8'); });
                res.on('end', function () {
                    expect(data.length).to.not.be(0);
                    done();
                });
                res.on('error', done);
            });
        });

        xit('logStream - requires event-stream accept header', function (done) {
            superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID + '/logstream')
                .query({ access_token: token, fromLine: 0 })
                .end(function (err, res) {
                expect(res.statusCode).to.be(400);
                done();
            });
        });


        xit('logStream - stream logs', function (done) {
            var options = {
                port: config.get('port'), host: 'localhost', path: '/api/v1/apps/' + APP_ID + '/logstream?access_token=' + token,
                headers: { 'Accept': 'text/event-stream', 'Connection': 'keep-alive' }
            };

            // superagent doesn't work. maybe https://github.com/visionmedia/superagent/issues/420
            var req = http.get(options, function (res) {
                var data = '';
                res.on('data', function (d) { data += d.toString('utf8'); });
                setTimeout(function checkData() {
                    expect(data.length).to.not.be(0);
                    var lineNumber = 1;
                    data.split('\n').forEach(function (line) {
                        if (line.indexOf('id: ') !== 0) return;
                        expect(parseInt(line.substr(4), 10)).to.be(lineNumber); // line number
                        ++lineNumber;
                    });

                    req.abort();
                    expect(lineNumber).to.be.above(1);
                    done();
                }, 1000);
                res.on('error', done);
            });

            req.on('error', done);
        });

        it('non admin cannot stop app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/stop')
                .query({ access_token: token_1 })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
        });

        it('can stop app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/stop')
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                done();
            });
        });

        it('did stop the app', function (done) {
            function waitForAppToDie() {
                superagent.get('http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath).end(function (err, res) {
                    if (!err || err.code !== 'ECONNREFUSED') return setTimeout(waitForAppToDie, 500);

                    // wait for app status to be updated
                    superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID).query({ access_token: token_1 }).end(function (error, result) {
                        if (error || result.statusCode !== 200 || result.body.runState !== 'stopped') return setTimeout(waitForAppToDie, 500);
                        done();
                    });
                });
            }

            waitForAppToDie();
        });

        it('nonadmin cannot start app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/start')
                .query({ access_token: token_1 })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
        });

        it('can start app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/start')
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                done();
            });
        });

        it('did start the app', function (done) {
            var count = 0;
            function checkStartState() {
                superagent.get('http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath)
                    .end(function (err, res) {
                    if (res && res.statusCode === 200) return done();
                    if (++count > 50) return done(new Error('Timedout'));
                    setTimeout(checkStartState, 500);
                });
            }

            checkStartState();
        });

        it('installation - app can check addons', function (done) {
            async.retry({ times: 100, interval: 5000 }, function (callback) {
                superagent.get('http://localhost:' + appEntry.httpPort + '/check_addons')
                    .query({ username: USERNAME, password: PASSWORD })
                    .end(function (err, res) {
                    expect(!err).to.be.ok();
                    expect(res.statusCode).to.equal(200);

                    delete res.body.sendmail; // sendmail auth fails
                    delete res.body.recvmail; // dovecot mail delivery won't work
                    delete res.body.stdenv; // cannot access APP_ORIGIN

                    for (var key in res.body) {
                        if (res.body[key] !== 'OK') return callback('Not done yet');
                    }

                    callback();
                });
            }, done);
        });

        it('can uninstall app', function (done) {
            var count = 0;
            function checkUninstallStatus() {
                superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
                   .query({ access_token: token })
                   .end(function (err, res) {
                    if (res.statusCode === 404) return done(null);
                    if (++count > 50) return done(new Error('Timedout'));
                    setTimeout(checkUninstallStatus, 1000);
                });
            }

            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
                .send({ password: PASSWORD })
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                checkUninstallStatus();
            });
        });

        it('uninstalled - container destroyed', function (done) {
            docker.getContainer(appEntry.containerId).inspect(function (error, data) {
                if (data) {
                    console.log('Container is still alive', data);
                }
                expect(error).to.be.ok();
                done();
            });
        });

        it('uninstalled - image destroyed', function (done) {
            expect(imageDeleted).to.be.ok();
            done();
        });

        it('uninstalled - volume destroyed', function (done) {
            expect(!fs.existsSync(paths.DATA_DIR + '/' + APP_ID));
            done();
        });

        it('uninstalled - unregistered subdomain', function (done) {
            apiHockInstance.done(function (error) { // checks if all the apiHockServer APIs were called
                expect(!error).to.be.ok();

                awsHockInstance.done(function (error) {
                    expect(!error).to.be.ok();
                    done();
                });
            });
        });

        it('uninstalled - removed nginx', function (done) {
            expect(!fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP_LOCATION + '.conf'));
            done();
        });

        it('uninstalled - removed redis addon', function (done) {
            docker.getContainer('redis-' + APP_ID).inspect(function (error, data) {
                expect(error).to.be.ok();
                done();
            });
        });
    });

    describe('App installation - port bindings', function () {
        this.timeout(50000);

        var apiHockInstance = hock.createHock({ throwOnUnmatched: false }), apiHockServer;
        var awsHockInstance = hock.createHock({ throwOnUnmatched: false }), awsHockServer;

        // *.foobar.com
        var validCert1 = '-----BEGIN CERTIFICATE-----\nMIIBvjCCAWgCCQCg957GWuHtbzANBgkqhkiG9w0BAQsFADBmMQswCQYDVQQGEwJE\nRTEPMA0GA1UECAwGQmVybGluMQ8wDQYDVQQHDAZCZXJsaW4xEDAOBgNVBAoMB05l\nYnVsb24xDDAKBgNVBAsMA0NUTzEVMBMGA1UEAwwMKi5mb29iYXIuY29tMB4XDTE1\nMTAyODEzMDI1MFoXDTE2MTAyNzEzMDI1MFowZjELMAkGA1UEBhMCREUxDzANBgNV\nBAgMBkJlcmxpbjEPMA0GA1UEBwwGQmVybGluMRAwDgYDVQQKDAdOZWJ1bG9uMQww\nCgYDVQQLDANDVE8xFTATBgNVBAMMDCouZm9vYmFyLmNvbTBcMA0GCSqGSIb3DQEB\nAQUAA0sAMEgCQQC0FKf07ZWMcABFlZw+GzXK9EiZrlJ1lpnu64RhN99z7MXRr8cF\nnZVgY3jgatuyR5s3WdzUvye2eJ0rNicl2EZJAgMBAAEwDQYJKoZIhvcNAQELBQAD\nQQAw4bteMZAeJWl2wgNLw+wTwAH96E0jyxwreCnT5AxJLmgimyQ0XOF4FsssdRFj\nxD9WA+rktelBodJyPeTDNhIh\n-----END CERTIFICATE-----';
        var validKey1 = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOQIBAAJBALQUp/TtlYxwAEWVnD4bNcr0SJmuUnWWme7rhGE333PsxdGvxwWd\nlWBjeOBq27JHmzdZ3NS/J7Z4nSs2JyXYRkkCAwEAAQJALV2eykcoC48TonQEPmkg\nbhaIS57syw67jMLsQImQ02UABKzqHPEKLXPOZhZPS9hsC/hGIehwiYCXMUlrl+WF\nAQIhAOntBI6qaecNjAAVG7UbZclMuHROUONmZUF1KNq6VyV5AiEAxRLkfHWy52CM\njOQrX347edZ30f4QczvugXwsyuU9A1ECIGlGZ8Sk4OBA8n6fAUcyO06qnmCJVlHg\npTUeOvKk5c9RAiBs28+8dCNbrbhVhx/yQr9FwNM0+ttJW/yWJ+pyNQhr0QIgJTT6\nxwCWYOtbioyt7B9l+ENy3AMSO3Uq+xmIKkvItK4=\n-----END RSA PRIVATE KEY-----';

        before(function (done) {
            imageDeleted = false;
            imageCreated = false;


            APP_ID = uuid.v4();

            async.series([
                setup,

                function (callback) {
                    config.set('fqdn', 'test.foobar.com');
                    callback();
                },

                function (callback) {
                    apiHockInstance
                        .get('/api/v1/apps/' + APP_STORE_ID + '/versions/' + APP_MANIFEST.version + '/icon')
                        .replyWithFile(200, path.resolve(__dirname, '../../../webadmin/src/img/appicon_fallback.png'));

                    var port = parseInt(url.parse(config.apiServerOrigin()).port, 10);
                    apiHockServer = http.createServer(apiHockInstance.handler).listen(port, callback);
                },

                settings.setDnsConfig.bind(null, { provider: 'route53', accessKeyId: 'accessKeyId', secretAccessKey: 'secretAccessKey', endpoint: 'http://localhost:5353' }),

                settings.setTlsConfig.bind(null, { provider: 'caas' }),

                function (callback) {
                    awsHockInstance
                        .get('/2013-04-01/hostedzone')
                        .max(Infinity)
                        .reply(200, js2xml('ListHostedZonesResponse', awsHostedZones, { arrayMap: { HostedZones: 'HostedZone'} }), { 'Content-Type': 'application/xml' })
                        .filteringRequestBody(function (unusedBody) { return ''; }) // strip out body
                        .post('/2013-04-01/hostedzone/ZONEID/rrset/')
                        .max(Infinity)
                        .reply(200, js2xml('ChangeResourceRecordSetsResponse', { ChangeInfo: { Id: 'dnsrecordid', Status: 'INSYNC' } }), { 'Content-Type': 'application/xml' });

                    awsHockServer = http.createServer(awsHockInstance.handler).listen(5353, callback);
                }
            ], done);
        });

        after(function (done) {
            APP_ID = null;
            async.series([
                cleanup,
                apiHockServer.close.bind(apiHockServer),
                awsHockServer.close.bind(awsHockServer)
            ], done);
        });

        var appResult = null, appEntry = null;

        it('can install test app', function (done) {
            var fake = nock(config.apiServerOrigin()).post('/api/v1/apps/test/purchase?token=APPSTORE_TOKEN').reply(201, {});

            var count = 0;
            function checkInstallStatus() {
                superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
                   .query({ access_token: token })
                   .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    if (res.body.installationState === appdb.ISTATE_INSTALLED) { appResult = res.body; return done(null); }
                    if (res.body.installationState === appdb.ISTATE_ERROR) return done(new Error('Install error'));
                    if (++count > 50) return done(new Error('Timedout'));
                    setTimeout(checkInstallStatus, 1000);
                });
            }

            superagent.post(SERVER_URL + '/api/v1/apps/install')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, appStoreId: APP_STORE_ID, manifest: APP_MANIFEST, password: PASSWORD, location: APP_LOCATION, portBindings: { ECHO_SERVER_PORT: 7171 }, accessRestriction: null })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                expect(fake.isDone()).to.be.ok();
                expect(res.body.id).to.equal(APP_ID);
                checkInstallStatus();
            });
        });

        it('installation - image created', function (done) {
            expect(imageCreated).to.be.ok();
            done();
        });

        it('installation - can get app', function (done) {
            apps.get(appResult.id, function (error, app) {
                expect(!error).to.be.ok();
                expect(app).to.be.an('object');
                appEntry = app;
                done();
            });
        });

        it('installation - container created', function (done) {
            expect(appResult.containerId).to.be(undefined);
            expect(appEntry.containerId).to.be.ok();
            docker.getContainer(appEntry.containerId).inspect(function (error, data) {
                expect(error).to.not.be.ok();
                expect(data.Config.ExposedPorts['7777/tcp']).to.eql({ });
                expect(data.Config.Env).to.contain('ECHO_SERVER_PORT=7171');
                expect(data.HostConfig.PortBindings['7778/tcp'][0].HostPort).to.eql('7171');
                done();
            });
        });

        it('installation - nginx config', function (done) {
            expect(fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP_LOCATION + '.conf'));
            done();
        });

        it('installation - registered subdomain', function (done) {
            // this is checked in unregister subdomain testcase
            done();
        });

        it('installation - volume created', function (done) {
            expect(fs.existsSync(paths.DATA_DIR + '/' + APP_ID));
            done();
        });

        it('installation - http is up and running', function (done) {
            var tryCount = 20;
            expect(appResult.httpPort).to.be(undefined);
            (function healthCheck() {
                superagent.get('http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath)
                    .end(function (err, res) {
                    if (err || res.statusCode !== 200) {
                        if (--tryCount === 0) return done(new Error('Timedout'));
                        return setTimeout(healthCheck, 2000);
                    }

                    expect(!err).to.be.ok();
                    expect(res.statusCode).to.equal(200);
                    done();
                });
            })();
        });

        it('installation - tcp port mapping works', function (done) {
            var client = net.connect(7171);
            client.on('data', function (data) {
                expect(data.toString()).to.eql('ECHO_SERVER_PORT=7171');
                done();
            });
            client.on('error', done);
        });

        it('installation - running container has volume mounted', function (done) {
            docker.getContainer(appEntry.containerId).inspect(function (error, data) {
                expect(error).to.not.be.ok();

                // support newer docker versions
                if (data.Volumes) {
                    expect(data.Volumes['/app/data']).to.eql(paths.DATA_DIR + '/' + APP_ID + '/data');
                } else {
                    expect(data.Mounts.filter(function (mount) { return mount.Destination === '/app/data'; })[0].Source).to.eql(paths.DATA_DIR + '/' + APP_ID + '/data');
                }

                done();
            });
        });


        it('installation - app can populate addons', function (done) {
            superagent.get('http://localhost:' + appEntry.httpPort + '/populate_addons').end(function (err, res) {
                expect(!err).to.be.ok();
                expect(res.statusCode).to.equal(200);
                for (var key in res.body) {
                    expect(res.body[key]).to.be('OK');
                }
                done();
            });
        });

        it('installation - app can check addons', function (done) {
            async.retry({ times: 100, interval: 5000 }, function (callback) {
                superagent.get('http://localhost:' + appEntry.httpPort + '/check_addons')
                    .query({ username: USERNAME, password: PASSWORD })
                    .end(function (err, res) {
                    expect(!err).to.be.ok();
                    expect(res.statusCode).to.equal(200);

                    delete res.body.sendmail; // sendmail auth fails
                    delete res.body.recvmail; // dovecot mail delivery won't work
                    delete res.body.stdenv; // cannot access APP_ORIGIN

                    for (var key in res.body) {
                        if (res.body[key] !== 'OK') return callback('Not done yet');
                    }

                    callback();
                });
            }, done);
        });

        var redisIp, exportedRedisPort;

        it('installation - redis addon created', function (done) {
            docker.getContainer('redis-' + APP_ID).inspect(function (error, data) {
                expect(error).to.not.be.ok();
                expect(data).to.be.ok();

                redisIp = safe.query(data, 'NetworkSettings.IPAddress');
                expect(redisIp).to.be.ok();

                exportedRedisPort = safe.query(data, 'NetworkSettings.Ports.6379/tcp[0].HostPort');
                expect(exportedRedisPort).to.be.ok();

                done();
            });
        });

        function checkConfigureStatus(count, done) {
            assert.strictEqual(typeof count, 'number');
            assert.strictEqual(typeof done, 'function');

            superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
               .query({ access_token: token })
               .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                if (res.body.installationState === appdb.ISTATE_INSTALLED) { appResult = res.body; expect(appResult).to.be.ok(); return done(null); }
                if (res.body.installationState === appdb.ISTATE_ERROR) return done(new Error('Install error'));
                if (++count > 50) return done(new Error('Timedout'));
                setTimeout(checkConfigureStatus.bind(null, count, done), 1000);
            });
        }

        it('cannot reconfigure app with missing location', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('cannot reconfigure app with missing accessRestriction', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 } })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('cannot reconfigure app with only the cert, no key', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null, cert: validCert1 })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('cannot reconfigure app with only the key, no cert', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null, key: validKey1 })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('cannot reconfigure app with cert not bein a string', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null, cert: 1234, key: validKey1 })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('cannot reconfigure app with key not bein a string', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null, cert: validCert1, key: 1234 })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('non admin cannot reconfigure app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token_1 })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
        });

        it('can reconfigure app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                checkConfigureStatus(0, done);
            });
        });

        it('changed container id after reconfigure', function (done) {
            var oldContainerId = appEntry.containerId;
            apps.get(appResult.id, function (error, app) {
                expect(!error).to.be.ok();
                expect(app).to.be.an('object');
                appEntry = app;
                expect(appEntry.containerid).to.not.be(oldContainerId);
                done();
            });
        });

        it('port mapping works after reconfiguration', function (done) {
            setTimeout(function () {
                var client = net.connect(7172);
                client.on('data', function (data) {
                    expect(data.toString()).to.eql('ECHO_SERVER_PORT=7172');
                    done();
                });
                client.on('error', done);
            }, 2000);
        });

        it('reconfiguration - redis addon recreated', function (done) {
            docker.getContainer('redis-' + APP_ID).inspect(function (error, data) {
                expect(error).to.not.be.ok();
                expect(data).to.be.ok();

                redisIp = safe.query(data, 'NetworkSettings.IPAddress');
                expect(redisIp).to.be.ok();

                exportedRedisPort = safe.query(data, 'NetworkSettings.Ports.6379/tcp[0].HostPort');
                expect(exportedRedisPort).to.be.ok();

                done();
            });
        });

        it('installation - app can check addons', function (done) {
            async.retry({ times: 100, interval: 5000 }, function (callback) {
                superagent.get('http://localhost:' + appEntry.httpPort + '/check_addons')
                    .query({ username: USERNAME, password: PASSWORD })
                    .end(function (err, res) {
                    expect(!err).to.be.ok();
                    expect(res.statusCode).to.equal(200);

                    delete res.body.sendmail; // sendmail auth fails
                    delete res.body.recvmail; // dovecot mail delivery won't work
                    delete res.body.stdenv; // cannot access APP_ORIGIN

                    for (var key in res.body) {
                        if (res.body[key] !== 'OK') return callback('Not done yet');
                    }

                    callback();
                });
            }, done);
        });

        it('can reconfigure app with custom certificate', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                  .query({ access_token: token })
                  .send({ appId: APP_ID, password: PASSWORD, location: APP_LOCATION_NEW, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null, cert: validCert1, key: validKey1 })
                  .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                checkConfigureStatus(0, done);
            });
        });

        it('can stop app', function (done) {
            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/stop')
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                done();
            });
        });

        // osx: if this test is failing, it is probably because of a stray port binding in boot2docker
        it('did stop the app', function (done) {
            var timer1, timer2;

            function finished() {
                clearTimeout(timer1);
                clearTimeout(timer2);

                if (done) done();

                // avoid double callbacks
                done = null;
            }

            function waitForAppToDie() {
                var client = net.connect(7171);
                client.setTimeout(2000);
                client.on('connect', function () {
                    timer1 = setTimeout(waitForAppToDie, 1000);
                });
                client.on('timeout', function () { finished(); });
                client.on('error', function (error) { finished(); });
                client.on('data', function (data) {
                    timer2 = setTimeout(waitForAppToDie, 1000);
                });
            }

            waitForAppToDie();
        });

        it('can uninstall app', function (done) {
            var count = 0;
            function checkUninstallStatus() {
                superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
                   .query({ access_token: token })
                   .end(function (err, res) {
                    if (res.statusCode === 404) return done(null);
                    if (++count > 50) return done(new Error('Timedout'));
                    setTimeout(checkUninstallStatus, 1000);
                });
            }

            superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
                .send({ password: PASSWORD })
                .query({ access_token: token })
                .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                checkUninstallStatus();
            });
        });

        it('uninstalled - container destroyed', function (done) {
            docker.getContainer(appEntry.containerId).inspect(function (error, data) {
                expect(error).to.be.ok();
                expect(data).to.not.be.ok();
                done();
            });
        });

        it('uninstalled - image destroyed', function (done) {
            expect(imageDeleted).to.be.ok();
            done();
        });

        it('uninstalled - volume destroyed', function (done) {
            expect(!fs.existsSync(paths.DATA_DIR + '/' + APP_ID));
            done();
        });

        it('uninstalled - unregistered subdomain', function (done) {
            apiHockInstance.done(function (error) { // checks if all the apiHockServer APIs were called
                expect(!error).to.be.ok();

                awsHockInstance.done(function (error) {
                    expect(!error).to.be.ok();
                    done();
                });
            });
        });

        it('uninstalled - removed nginx', function (done) {
            expect(!fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP_LOCATION + '.conf'));
            done();
        });

        it('uninstalled - removed redis addon', function (done) {
            docker.getContainer('redis-' + APP_ID).inspect(function (error, data) {
                expect(error).to.be.ok();
                done();
            });
        });
    });
});
