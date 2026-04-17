const express = require(‘express’);
const fetch = require(‘node-fetch’);

const app = express();
app.use(express.json());
app.use(express.static(‘public’));

const PORT        = process.env.PORT       || 3000;
const TG_TOKEN    = process.env.TG_TOKEN   || ‘’;
const TG_CHAT_ID  = process.env.TG_CHAT_ID || ‘’;
…})();
});