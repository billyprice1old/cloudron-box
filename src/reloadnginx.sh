#!/bin/bash

if [ $EUID -ne 0 ]; then
    echo "This script should be run as root." > /dev/stderr
    exit 1
fi

if [ "$1" == "--check" ]; then
    echo "OK"
    exit 0
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
    # On Mac, brew installs supervisor in /usr/local/bin
    export PATH=$PATH:/usr/local/bin
fi

supervisorctl -c supervisor/supervisord.conf pid nginx | xargs kill -s HUP
