var express = require('express');
var logger = require('morgan');
var https = require('https');
var crypto = require('crypto');
var querystring = require('querystring');

var app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

var CLIENT_ID = process.env.CAFE24_CLIENT_ID;
var CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
var MALL_ID = process.env.CAFE24_MALL_ID || 'scalpborn3';
var REDIRECT_URI = process.env.CAFE24_REDIRECT_URI;

var oauthStates = new Map();

/* 카페24 테스트 실행 시 OAuth 인증 시작 */
app.get('/', function (req, res) {
  var mallId = req.query.mall_id || MALL_ID;

  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).json({
      ok: false,
      message: 'Cafe24 환경변수 설정이 필요합니다.',
      required: [
        'CAFE24_CLIENT_ID',
        'CAFE24_CLIENT_SECRET',
        'CAFE24_MALL_ID',
        'CAFE24_REDIRECT_URI'
      ]
    });
  }

  var state = crypto.randomBytes(32).toString('hex');

  oauthStates.set(state, {
    mallId: mallId,
    createdAt: Date.now()
  });

  var params = querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    state: state,
    redirect_uri: REDIRECT_URI,
    scope: 'mall.read_order'
  });

  var authorizationUrl =
    'https://' +
    mallId +
    '.cafe24api.com/api/v2/oauth/authorize?' +
    params;

  return res.redirect(authorizationUrl);
});

/* 서버 상태 확인 */
app.get('/health', function (req, res) {
  res.status(200).json({
    ok: true,
    service: 'ScalpBorn Auto Message'
  });
});

/* 카페24 OAuth 인증 결과 수신 */
app.get('/oauth', function (req, res) {
  var code = req.query.code;
  var state = req.query.state;
  var error = req.query.error;

  if (error) {
    return res.status(400).json({
      ok: false,
      message: '카페24 인증이 거부되었거나 실패했습니다.',
      error: error
    });
  }

  if (!code || !state) {
    return res.status(400).json({
      ok: false,
      message: '인증코드 또는 state 값이 없습니다.'
    });
  }

  var savedState = oauthStates.get(state);

  if (!savedState) {
    return res.status(400).json({
      ok: false,
      message: '유효하지 않거나 만료된 state 값입니다.'
    });
  }

  oauthStates.delete(state);

  var mallId = savedState.mallId;

  var requestBody = querystring.stringify({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI
  });

  var basicAuth = Buffer.from(
    CLIENT_ID + ':' + CLIENT_SECRET
  ).toString('base64');

  var requestOptions = {
    hostname: mallId + '.cafe24api.com',
    port: 443,
    path: '/api/v2/oauth/token',
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basicAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };

  var tokenRequest = https.request(
    requestOptions,
    function (tokenResponse) {
      var responseData = '';

      tokenResponse.on('data', function (chunk) {
        responseData += chunk;
      });

      tokenResponse.on('end', function () {
        var tokenData;

        try {
          tokenData = JSON.parse(responseData);
        } catch (parseError) {
          return res.status(500).json({
            ok: false,
            message: '카페24 토큰 응답을 해석하지 못했습니다.',
            rawResponse: responseData
          });
        }

        if (
          tokenResponse.statusCode < 200 ||
          tokenResponse.statusCode >= 300
        ) {
          return res.status(tokenResponse.statusCode).json({
            ok: false,
            message: 'Access Token 발급에 실패했습니다.',
            cafe24: tokenData
          });
        }

        console.log('Cafe24 OAuth connected:', {
          mall_id: tokenData.mall_id,
          shop_no: tokenData.shop_no,
          scopes: tokenData.scopes,
          expires_at: tokenData.expires_at
        });

        return res.status(200).json({
          ok: true,
          message: '카페24 OAuth 연결에 성공했습니다.',
          mall_id: tokenData.mall_id,
          shop_no: tokenData.shop_no,
          scopes: tokenData.scopes,
          expires_at: tokenData.expires_at,
          refresh_token_expires_at:
            tokenData.refresh_token_expires_at
        });
      });
    }
  );

  tokenRequest.on('error', function (requestError) {
    console.error(
      'Cafe24 token request error:',
      requestError
    );

    return res.status(500).json({
      ok: false,
      message:
        '카페24 토큰 서버 연결 중 오류가 발생했습니다.'
    });
  });

  tokenRequest.write(requestBody);
  tokenRequest.end();
});

/* 카페24 Webhook 수신 준비 */
app.post('/webhooks/cafe24', function (req, res) {
  console.log(
    'Cafe24 Webhook received:',
    req.body
  );

  res.status(200).json({
    received: true
  });
});

module.exports = app;
