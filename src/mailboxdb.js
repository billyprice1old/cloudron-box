'use strict';

exports = module.exports = {
    add: add,
    del: del,
    get: get,
    getAll: getAll,
    getAliases: getAliases,
    setAliases: setAliases,

    _clear: clear
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js'),
    util = require('util');

var MAILBOX_FIELDS = [ 'name', 'aliasTarget', 'creationTime' ].join(',');

function add(name, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO mailboxes (name) VALUES (?)', [ name ], function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('TRUNCATE TABLE mailboxes', [], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        callback(null);
    });
}

function del(name, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    // deletes aliases as well
    database.query('DELETE FROM mailboxes WHERE name=? OR aliasTarget = ?', [ name, name ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function postProcess(result) {
    result.aliases = result.aliases ? result.aliases.split(',') : [ ];
}

function get(name, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    var query = 'SELECT m1.name, m1.creationTime, GROUP_CONCAT(m2.name) AS aliases ' +
                'FROM mailboxes as m1 ' +
                'LEFT OUTER JOIN mailboxes as m2 ON m1.name = m2.aliasTarget ' +
                'WHERE m1.name=? AND m1.aliasTarget IS NULL ' +
                'GROUP BY m1.name';

    database.query(query, [ name ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(results[0]);

        callback(null, results[0]);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    var query = 'SELECT m1.name, m1.creationTime, GROUP_CONCAT(m2.name) AS aliases ' +
                'FROM mailboxes as m1 ' +
                'LEFT OUTER JOIN mailboxes as m2 ON m1.name = m2.aliasTarget ' +
                'WHERE m1.aliasTarget IS NULL ' +
                'GROUP BY m1.name';

    database.query(query, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}

function setAliases(name, aliases, callback) {
    assert.strictEqual(typeof name, 'string');
    assert(util.isArray(aliases));
    assert.strictEqual(typeof callback, 'function');

    // also cleanup the groupMembers table
    var queries = [];
    queries.push({ query: 'DELETE FROM mailboxes WHERE aliasTarget = ?', args: [ name ] });
    aliases.forEach(function (alias) {
        queries.push({ query: 'INSERT INTO mailboxes (name, aliasTarget) VALUES (?, ?)', args: [ alias, name ] });
    });

    database.transaction(queries, function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error.message));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function getAliases(name, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT name FROM mailboxes WHERE aliasTarget=? ORDER BY name', [ name ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results = results.map(function (r) { return r.name; });
        callback(null, results);
    });
}