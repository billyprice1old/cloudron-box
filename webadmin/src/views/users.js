'use strict';

angular.module('Application').controller('UsersController', ['$scope', '$location', 'Client', function ($scope, $location, Client) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.ready = false;
    $scope.users = [];
    $scope.groups = [];
    $scope.config = Client.getConfig();
    $scope.userInfo = Client.getUserInfo();

    $scope.userremove = {
        busy: false,
        error: {},
        userInfo: {},
        username: '',
        password: ''
    };

    $scope.useradd = {
        busy: false,
        alreadyTaken: false,
        error: {},
        email: '',
        sendInvite: true
    };

    $scope.useredit = {
        busy: false,
        error: {},
        userInfo: {},
        email: '',
        aliases: '',
        superuser: false
    };

    $scope.showBubble = function ($event) {
        $($event.target).tooltip('show');

        setTimeout(function () {
            $($event.target).tooltip('hide');
        }, 2000);
    };

    $scope.groupAdd = {
        busy: false,
        error: {},
        name: '',

        show: function () {
            $scope.groupAdd.busy = false;

            $scope.groupAdd.error = {};
            $scope.groupAdd.name = '';

            $scope.groupAddForm.$setUntouched();
            $scope.groupAddForm.$setPristine();

            $('#groupAddModal').modal('show');
        },

        submit: function () {
            $scope.groupAdd.busy = true;
            $scope.groupAdd.error = {};

            Client.createGroup($scope.groupAdd.name, function (error) {
                $scope.groupAdd.busy = false;

                if (error && error.statusCode === 409) {
                    $scope.groupAdd.error.name = 'Name already taken';
                    $scope.groupAddForm.name.$setPristine();
                    $('#groupAddName').focus();
                    return;
                }
                if (error && error.statusCode === 400) {
                    $scope.groupAdd.error.name = error.message;
                    $scope.groupAddForm.name.$setPristine();
                    $('#groupAddName').focus();
                    return;
                }
                if (error) return console.error('Unable to create group.', error.statusCode, error.message);

                refresh();
                $('#groupAddModal').modal('hide');
            });
        }
    };

    $scope.inviteSent = {
        email: '',
        setupLink: ''
    };

    $scope.groupRemove = {
        busy: false,
        error: {},
        group: null,
        password: '',
        memberCount: 0,

        show: function (group) {
            $scope.groupRemove.busy = false;

            $scope.groupRemove.error = {};
            $scope.groupRemove.password = '';

            $scope.groupRemove.group = angular.copy(group);

            $scope.groupRemoveForm.$setUntouched();
            $scope.groupRemoveForm.$setPristine();

            Client.getGroup(group.id, function (error, result) {
                if (error) return console.error('Unable to fetch group information.', error.statusCode, error.message);

                $scope.groupRemove.memberCount = result.userIds.length;

                $('#groupRemoveModal').modal('show');
            });
        },

        submit: function () {
            $scope.groupRemove.busy = true;
            $scope.groupRemove.error = {};

            Client.removeGroup($scope.groupRemove.group.id, $scope.groupRemove.password, function (error) {
                $scope.groupRemove.busy = false;

                if (error && error.statusCode === 403) {
                    $scope.groupRemove.error.password = 'Wrong password';
                    $scope.groupRemove.password = '';
                    $scope.groupRemoveForm.password.$setPristine();
                    $('#groupRemovePasswordInput').focus();
                    return;
                }
                if (error) return console.error('Unable to remove group.', error.statusCode, error.message);

                refresh();
                $('#groupRemoveModal').modal('hide');
            });
        }
    };

    $scope.isMe = function (user) {
        return user.username === Client.getUserInfo().username;
    };

    $scope.isAdmin = function (user) {
        return !!user.admin;
    };

    $scope.sendInvite = function (user) {
        $scope.inviteSent.email = user.email;
        $scope.inviteSent.setupLink = '';

        Client.sendInvite(user, function (error, resetToken) {
            if (error) return console.error(error);

            // Client.notify('', 'Invitation was successfully sent to ' + user.email + '.', false, 'success');

            $scope.inviteSent.setupLink = location.origin + '/api/v1/session/account/setup.html?reset_token=' + resetToken;
            $('#inviteSentModal').modal('show');
        });
    };

    $scope.showUserAdd = function () {
        $scope.useradd.error = {};
        $scope.useradd.email = '';

        $scope.useradd_form.$setUntouched();
        $scope.useradd_form.$setPristine();

        $('#userAddModal').modal('show');
    };

    $scope.doAdd = function () {
        $scope.useradd.busy = true;

        $scope.useradd.alreadyTaken = false;
        $scope.useradd.error.email = null;

        Client.createUser('' /* username */, $scope.useradd.email, '' /* displayName */, $scope.useradd.sendInvite, function (error) {
            $scope.useradd.busy = false;

            if (error && error.statusCode === 409) {
                $scope.useradd.error.email = 'Email already taken';
                $scope.useradd_form.email.$setPristine();
                $('#inputUserAddEmail').focus();
                return;
            }
            if (error && error.statusCode === 400) {
                if (error.message.indexOf('email') !== -1) {
                    $scope.useradd.error.email = 'Invalid Email';
                    $scope.useradd.error.emailAttempted = $scope.useradd.email;
                    $scope.useradd_form.email.$setPristine();
                    $('#inputUserAddEmail').focus();
                } else {
                    console.error('Unable to create user.', error.statusCode, error.message);
                }
                return;
            }
            if (error) return console.error('Unable to create user.', error.statusCode, error.message);

            $scope.useradd.error = {};
            $scope.useradd.email = '';

            $scope.useradd_form.$setUntouched();
            $scope.useradd_form.$setPristine();

            refresh();

            $('#userAddModal').modal('hide');
        });
    };

    $scope.showUserEdit = function (userInfo) {
        $scope.useredit.error.email = null;
        $scope.useredit.email = userInfo.email;
        $scope.useredit.userInfo = userInfo;
        $scope.useredit.aliases = mailboxes[userInfo.username].aliases.join(',');
        $scope.useredit.groupIds = angular.copy(userInfo.groupIds);
        $scope.useredit.superuser = userInfo.groupIds.indexOf('admin') !== -1;

        $scope.useredit_form.$setPristine();
        $scope.useredit_form.$setUntouched();

        $('#userEditModal').modal('show');
    };

    $scope.userEditToggleGroup = function (group) {
        var pos = $scope.useredit.groupIds.indexOf(group.id);
        if (pos === -1) {
            $scope.useredit.groupIds.push(group.id);
        } else {
            $scope.useredit.groupIds.splice(pos, 1);
        }
    };

    $scope.doUserEdit = function () {
        $scope.useredit.error.email = null;
        $scope.useredit.busy = true;

        var data = {
            id: $scope.useredit.userInfo.id,
            email: $scope.useredit.email
        };

        Client.updateUser(data, function (error) {
            if (error) {
                $scope.useredit.busy = false;
                return console.error('Unable to update user:', error);
            }

            if ($scope.useredit.superuser) {
                if ($scope.useredit.groupIds.indexOf('admin') === -1) $scope.useredit.groupIds.push('admin');
            } else {
                $scope.useredit.groupIds = $scope.useredit.groupIds.filter(function (groupId) { return groupId !== 'admin'; });
            }

            Client.setGroups(data.id, $scope.useredit.groupIds, function (error) {
                if (error) return console.error('Unable to update groups for user:', error);

                Client.setAliases($scope.useredit.userInfo.username, $scope.useredit.aliases.split(','), function (error) {
                    $scope.useredit.busy = false;

                    if (error) return console.error('Unable to update aliases for user:', error);

                    $scope.useredit.userInfo = {};
                    $scope.useredit.email = '';
                    $scope.useredit.superuser = false;
                    $scope.useredit.groupIds = [];
                    $scope.useredit.aliases = '';

                    $scope.useredit_form.$setPristine();
                    $scope.useredit_form.$setUntouched();

                    refresh();

                    $('#userEditModal').modal('hide');
                });
            });
        });
    };

    $scope.showUserRemove = function (userInfo) {
        $scope.userremove.error.username = null;
        $scope.userremove.error.password = null;
        $scope.userremove.username = '';
        $scope.userremove.password = '';
        $scope.userremove.userInfo = userInfo;

        $scope.userremove_form.$setPristine();
        $scope.userremove_form.$setUntouched();

        $('#userRemoveModal').modal('show');
    };

    $scope.doUserRemove = function () {
        $scope.userremove.error.username = null;
        $scope.userremove.error.password = null;

        if ($scope.userremove.username !== $scope.userremove.userInfo.username && $scope.userremove.username !== $scope.userremove.userInfo.email) {
            $scope.userremove.error.username = true;
            $scope.userremove.username = '';
            $scope.userremove_form.username.$setPristine();
            $('#inputUserRemoveUsername').focus();
            return;
        }

        $scope.userremove.busy = true;

        Client.removeUser($scope.userremove.userInfo.id, $scope.userremove.password, function (error) {
            $scope.userremove.busy = false;

            if (error && error.statusCode === 403) {
                $scope.userremove.error.password = 'Wrong password';
                $scope.userremove.password = '';
                $scope.userremove_form.password.$setPristine();
                $('#inputUserRemovePassword').focus();
                return;
            }
            if (error) return console.error('Unable to delete user.', error);

            $scope.userremove.userInfo = {};
            $scope.userremove.username = '';
            $scope.userremove.password = '';

            $scope.userremove_form.$setPristine();
            $scope.userremove_form.$setUntouched();

            refresh();

            $('#userRemoveModal').modal('hide');
        });
    };

    function refresh() {
        Client.getGroups(function (error, result) {
            if (error) return console.error('Unable to get group listing.', error);

            $scope.groups = result;

            Client.getUsers(function (error, result) {
                if (error) return console.error('Unable to get user listing.', error);

                $scope.users = result;

                Client.getMailboxes(function (error, result) {
                    if (error) return console.error('Unable to get mailboxes.', error);

                    $scope.mailboxes = result;

                    $scope.ready = true;
                });
            });
        });
    }

    refresh();

    $scope.initTooltip = function () {
        $('[data-toggle="tooltip"]').tooltip();
    };

    // setup all the dialog focus handling
    ['userAddModal', 'userRemoveModal', 'userEditModal', 'groupAddModal', 'groupRemoveModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });
}]);
