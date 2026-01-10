let webpack = require('vortex-api/bin/webpack').default;

config = webpack('discord-rpc', __dirname, 5);

module.exports = config;