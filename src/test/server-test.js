'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var Server = require('../server.js'),
    request = require('superagent'),
    path = require('path'),
    crypto = require('crypto'),
    rimraf = require('rimraf'),
    os = require('os'),
    expect = require('expect.js'),
    nock = require('nock'),
    config = require('../../config.js');

var SERVER_URL = 'http://localhost:' + config.port;

// remove all temporary folders
function cleanup(done) {
    rimraf(config.baseDir, done);
}

describe('Server', function () {
    this.timeout(5000);

    after(cleanup);

    describe('startup', function () {
        var server;

        it('start fails due to wrong arguments', function (done) {
            var s = new Server();

            expect(function () { s.start(); }).to.throwException();
            expect(function () { s.start('foobar', function () {}); }).to.throwException();
            expect(function () { s.start(1337, function () {}); }).to.throwException();

            done();
        });

        it('succeeds', function (done) {
            server = new Server();

            server.start(function (error) {
                expect(error).to.not.be.ok();
                done();
            });
        });

        it('is reachable', function (done) {
            request.get(SERVER_URL + '/api/v1/version', function (err, res) {
                expect(res.statusCode).to.equal(200);
                done(err);
            });
        });

        it('should fail because already running', function (done) {
            expect(server.start).to.throwException(function (e) {
                done();
            });
        });

        after(function (done) {
            server.stop(function () {
                done();
            });
        });
    });

    describe('runtime', function () {
        var server;

        before(function (done) {
            server = new Server();
            server.start(done);
        });

        it('random bad requests', function (done) {
            request.get(SERVER_URL + '/random', function (err, res) {
                expect(err).to.not.be.ok();
                expect(res.statusCode).to.equal(404);
                done(err);
            });
        });

        it('version', function (done) {
            request.get(SERVER_URL + '/api/v1/version', function (err, res) {
                expect(err).to.not.be.ok();
                expect(res.statusCode).to.equal(200);
                expect(res.body.version).to.equal(require('../../package.json').version);
                done(err);
            });
        });

        it('firsttime route is GET', function (done) {
            request.post(SERVER_URL + '/api/v1/firsttime')
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(404);

                request.get(SERVER_URL + '/api/v1/firsttime')
                       .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    done(err);
                });
            });
        });

        after(function (done) {
            server.stop(function () {
                done();
            });
        });
    });

    describe('shutdown', function () {
        var server;

        before(function (done) {
            server = new Server();
            server.start(done);
        });

        it('fails due to wrong arguments', function (done) {
            expect(function () { server.stop(); }).to.throwException();
            expect(function () { server.stop('foobar'); }).to.throwException();
            expect(function () { server.stop(1337); }).to.throwException();
            expect(function () { server.stop({}); }).to.throwException();
            expect(function () { server.stop({ httpServer: {} }); }).to.throwException();

            done();
        });

        it('succeeds', function (done) {
            server.stop(function () {
                done();
            });
        });

        it('is not reachable anymore', function (done) {
            request.get(SERVER_URL + '/api/v1/version', function (error, result) {
                expect(error).to.not.be(null);
                done();
            });
        });
    });

    describe('cors', function () {
        var server;

        before(function (done) {
            server = new Server();
            server.start(function (error) {
                done(error);
            });
        });

        it('responds to OPTIONS', function (done) {
            request('OPTIONS', SERVER_URL + '/api/v1/version')
                .set('Access-Control-Request-Method', 'GET')
                .set('Access-Control-Request-Headers', 'accept, origin, x-requested-with')
                .set('Origin', 'http://localhost')
                .end(function (res) {
                expect(res.headers['access-control-allow-methods']).to.be('GET, PUT, DELETE, POST, OPTIONS');
                expect(res.headers['access-control-allow-credentials']).to.be('true');
                expect(res.headers['access-control-allow-headers']).to.be('accept, origin, x-requested-with'); // mirrored from request
                expect(res.headers['access-control-allow-origin']).to.be('http://localhost'); // mirrors from request
                done();
            });
        });

        after(function (done) {
            server.stop(function () {
                done();
            });
        });
    });

    describe('announce', function () {
        var server;

        var failingGet, succeedingGet;

        before(function (done) {
            process.env.ANNOUNCE_INTERVAL = 20;

            var scope = nock(config.appServerUrl);
            failingGet = scope.get('/api/v1/boxes/' + config.fqdn + '/announce');
            failingGet.times(5).reply(502);

            succeedingGet = scope.get('/api/v1/boxes/' + config.fqdn + '/announce');
            succeedingGet.times(5).reply(200, { });

            server = new Server();
            server.start(done);
        });

        after(function (done) {
            server.stop(done);
            nock.cleanAll();
        });

        it('sends announce request repeatedly until success', function (done) {
            setTimeout(function () { config.set('token', 'provision'); }, 150); // enough time for 5 failures

            setTimeout(function () {
                expect(failingGet.counter).to.be(1); // mock seems to not decrement to 0 and just removes the interceptor
                expect(succeedingGet.counter).to.be(4); // server should have stopped after one 'success'

                done();
            }, 400);
        });
    });
});

