var express = require('express');
var logger = require('morgan');

var app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 서버 정상 작동 확인
app.get('/', function (req, res) {
  res.json({
    service: 'ScalpBorn Auto Message',
    status: 'running'
  });
});

// 서버 상태 확인용
app.get('/health', function (req, res) {
  res.status(200).json({
    ok: true
  });
});

// 카페24 Webhook 수신 준비
app.post('/webhooks/cafe24', function (req, res) {
  console.log('Cafe24 Webhook received:', req.body);

  res.status(200).json({
    received: true
  });
});

module.exports = app;
