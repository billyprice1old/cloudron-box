#!/bin/bash

set -e

USER=yellowtent
SRCDIR=/home/$USER/box
DATA_DIR=/home/$USER/data
COLLECTD_DIR="$DATA_DIR/collectd/"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

GRAPHITE_DIR="/home/yellowtent/data/graphite"
mkdir $GRAPHITE_DIR

docker run -d --name="graphite" \
    -p 127.0.0.1:2003:2003 \
    -p 127.0.0.1:2004:2004 \
    -p 127.0.0.1:8000:8000 \
    -v $GRAPHITE_DIR:/app/data girish/graphite:0.2

# collectd
mkdir -p $COLLECTD_DIR/collectd.conf.d
cp -r $SCRIPT_DIR/collectd/collectd.conf $COLLECTD_DIR/collectd.conf
rm -rf /etc/collectd
ln -sfF $COLLECTD_DIR /etc/collectd
chown -R yellowtent.yellowtent $COLLECTD_DIR

update-rc.d -f collectd defaults
/etc/init.d/collectd restart
