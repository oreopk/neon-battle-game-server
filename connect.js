
const express = require('express');
const path = require('path');
const http = require('http');
const app = express();
const WebSocket = require('ws');

const publicPath = path.join(__dirname, '../web/site/public');
app.use(express.static(publicPath));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

module.exports = {
    wss,
    server,
    app
};
