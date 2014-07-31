/* jslint node:true */

'use strict';

// this code is intentionally placed before the requires because of circular
// dependancy between database and the *db.js files
exports = module.exports = {
    init: init,
    get: get,
    getBySubdomain: getBySubdomain,
    add: add,
    del: del,
    update: update,
    getAll: getAll,
    getPortBindings: getPortBindings,

    // status codes
    ISTATE_PENDING_INSTALL: 'pending_install',
    ISTATE_PENDING_UNINSTALL: 'pending_uninstall',
    ISTATE_ERROR: 'error',
    ISTATE_DOWNLOADING_MANIFEST: 'downloading_manifest',
    ISTATE_DOWNLOADING_IMAGE: 'downloading_image',
    ISTATE_CREATING_CONTAINER: 'creating_container',
    ISTATE_CREATING_VOLUME: 'creating_volume',
    ISTATE_REGISTERING_SUBDOMAIN: 'registering_subdomain',
    ISTATE_SUBDOMAIN_ERROR: 'subdomain_error',
    ISTATE_INSTALLED: 'installed',

    RSTATE_RUNNING: 'running',
    RSTATE_ERROR: 'error',
    RSTATE_EXITED: 'exited',
    RSTATE_NOT_RESPONDING: 'not_responding'
};

var DatabaseError = require('./databaseerror'),
    debug = require('debug')('box:appdb'),
    assert = require('assert'),
    database = require('./database.js'),
    async = require('async'),
    util = require('util'),
    safe = require('safetydance');

// database
var db = null;

function init(_db) {
    assert(typeof _db === 'object');

    db = _db;
}

function get(id, callback) {
    assert(db !== null);
    assert(typeof id === 'string');
    assert(typeof callback === 'function');

    db.get('SELECT * FROM apps WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        if (typeof result === 'undefined') return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

        result.manifest = safe.JSON.parse(result.manifestJson);
        delete result.manifestJson;

        callback(null, result);
    });
}

function getBySubdomain(subdomain, callback) {
    assert(db !== null);
    assert(typeof subdomain === 'string');
    assert(typeof callback === 'function');

    db.get('SELECT * FROM apps WHERE location = ?', [ subdomain ], function (error, result) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        if (typeof result === 'undefined') return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

        result.manifest = safe.JSON.parse(result.manifestJson);
        delete result.manifestJson;

        callback(null, result);
    });
}

function getAll(callback) {
    assert(db !== null);

    db.all('SELECT * FROM apps', function (error, results) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        if (typeof results === 'undefined') results = [ ];

        results.forEach(function (result) {
            result.manifest = safe.JSON.parse(result.manifestJson);
            delete result.manifestJson;
        });

        callback(null, results);
    });
}

function add(id, installationState, location, portBindings, callback) {
    assert(db !== null);
    assert(typeof id === 'string');
    assert(typeof installationState === 'string');
    assert(typeof location === 'string');
    assert(util.isArray(portBindings));
    assert(typeof callback === 'function');

    portBindings = portBindings || { };

    var appData = {
        $id: id,
        $installationState: installationState,
        $location: location
    };

    var conn = database.newTransaction();

    conn.run('INSERT INTO apps (id, installationState, location) VALUES ($id, $installationState, $location)',
           appData, function (error) {
        if (error) database.rollback(conn);

        if (error && error.code === 'SQLITE_CONSTRAINT') return callback(new DatabaseError(error, DatabaseError.ALREADY_EXISTS));

        if (error || !this.lastID) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        async.eachSeries(portBindings, function iterator(binding, callback) {
            var portData = {
                $appId: id,
                $containerPort: binding.containerPort,
                $hostPort: binding.hostPort
            };

            conn.run('INSERT INTO appPortBindings (hostPort, containerPort, appId) VALUES ($hostPort, $containerPort, $appId)', portData, callback);
        }, function done(error) {
            if (error) database.rollback(conn);

            if (error && error.code === 'SQLITE_CONSTRAINT') return callback(new DatabaseError(error, DatabaseError.ALREADY_EXISTS));

            if (error /* || !this.lastID*/) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

            database.commit(conn, callback); // FIXME: can this fail?
        });
    });
}

function getPortBindings(id, callback) {
    db.all('SELECT * FROM appPortBindings WHERE appId = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        if (typeof result === 'undefined') result = [ ];

        callback(null, result);
    });
}

function del(id, callback) {
    assert(db !== null);
    assert(typeof id === 'string');
    assert(typeof callback === 'function');

    var conn = database.newTransaction();
    conn.run('DELETE FROM appPortBindings WHERE appId = ?', [ id ], function (error) {
        conn.run('DELETE FROM apps WHERE id = ?', [ id ], function (error) {
            if (error || this.changes !== 1) database.rollback(conn);

            if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));
            if (this.changes !== 1) return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

            database.commit(conn, callback); // FIXME: can this fail?
        });
    });
}

function update(id, app, callback) {
    assert(db !== null);
    assert(typeof id === 'string');
    assert(typeof app === 'object');
    assert(typeof callback === 'function');

    var args = [ ], values = [ ];
    for (var p in app) {
        if (!app.hasOwnProperty(p)) continue;

        if (p === 'manifest') {
            args.push('manifestJson = ?');
            values.push(JSON.stringify(app[p]));
        } else {
            args.push(p + ' = ?');
            values.push(app[p]);
        }
    }
    values.push(id);

    db.run('UPDATE apps SET ' + args.join(', ') + ' WHERE id = ?', values, function (error) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));
        if (this.changes !== 1) return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

        callback(null);
    });
}

