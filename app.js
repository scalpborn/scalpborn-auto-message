var express = require('express');
var logger = require('morgan');
var https = require('https');
var crypto = require('crypto');
var querystring = require('querystring');
var pool = require('./db');

var app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

var CLIENT_ID = process.env.CAFE24_CLIENT_ID;
var CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
var MALL_ID = process.env.CAFE24_MALL_ID || 'scalpborn3';
var REDIRECT_URI = process.env.CAFE24_REDIRECT_URI;

var oauthStates = new Map();
var oauthToken = null;

function formatDate(date) {
  var year = date.getFullYear();
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function cleanupOauthStates() {
  var expirationTime = Date.now() - 10 * 60 * 1000;
  oauthStates.forEach(function (value, key) {
    if (value.createdAt < expirationTime) {
      oauthStates.delete(key);
    }
  });
}

function requestCafe24Api(options, callback) {
  var completed = false;

  function finish(error, data, statusCode) {
    if (completed) return;
    completed = true;
    callback(error, data, statusCode);
  }

  var request = https.request(options, function (response) {
    var responseData = '';
    response.on('data', function (chunk) {
      responseData += chunk;
    });
    response.on('end', function () {
      var parsedData;
      try {
        parsedData = responseData ? JSON.parse(responseData) : {};
      } catch (parseError) {
        return finish(
          new Error('카페24 응답을 JSON으로 해석하지 못했습니다.'),
          null,
          response.statusCode
        );
      }
      finish(null, parsedData, response.statusCode);
    });
  });

  request.setTimeout(10000, function () {
    request.destroy(new Error('카페24 API 응답 시간이 10초를 초과했습니다.'));
  });

  request.on('error', function (error) {
    finish(error);
  });

  return request;
}

function fetchRecentOrders(limit, callback) {
  if (!oauthToken || !oauthToken.accessToken) {
    return callback(new Error('카페24 OAuth 인증을 먼저 완료해 주세요.'), null, 401);
  }

  var mallId = oauthToken.mallId || MALL_ID;
  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(endDate.getDate() - 30);

  var orderQuery = querystring.stringify({
    shop_no: oauthToken.shopNo || 1,
    start_date: formatDate(startDate),
    end_date: formatDate(endDate),
    limit: limit || 1
  });

  var requestOptions = {
    hostname: mallId + '.cafe24api.com',
    port: 443,
    path: '/api/v2/admin/orders?' + orderQuery,
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + oauthToken.accessToken,
      'Content-Type': 'application/json'
    }
  };

  var orderRequest = requestCafe24Api(requestOptions, function (requestError, orderData, statusCode) {
    if (requestError) {
      return callback(requestError, null, 500);
    }
    if (statusCode < 200 || statusCode >= 300) {
      return callback(new Error('카페24 주문 조회에 실패했습니다.'), orderData, statusCode);
    }
    callback(null, {
      searchPeriod: {
        start_date: formatDate(startDate),
        end_date: formatDate(endDate)
      },
      orderData: orderData
    }, 200);
  });

  orderRequest.end();
}

function initializeDatabase() {
  var createOrdersTable = `
    CREATE TABLE IF NOT EXISTS cafe24_orders (
      id BIGSERIAL PRIMARY KEY,
      cafe24_order_id VARCHAR(100) NOT NULL UNIQUE,
      shop_no INTEGER,
      member_id VARCHAR(100),
      member_email VARCHAR(255),
      billing_name VARCHAR(100),
      paid BOOLEAN NOT NULL DEFAULT FALSE,
      canceled BOOLEAN NOT NULL DEFAULT FALSE,
      payment_amount NUMERIC(14, 2),
      payment_method JSONB,
      order_date TIMESTAMPTZ,
      payment_date TIMESTAMPTZ,
      shipping_status VARCHAR(30),
      scenario_code VARCHAR(10),
      has_trial_product BOOLEAN NOT NULL DEFAULT FALSE,
      has_welcome_kit BOOLEAN NOT NULL DEFAULT FALSE,
      tracking_number VARCHAR(100),
      delivery_company VARCHAR(100),
      raw_order_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  return pool.query(createOrdersTable);
}

function saveCafe24Order(order) {
  var sql = `
    INSERT INTO cafe24_orders (
      cafe24_order_id,
      shop_no,
      member_id,
      member_email,
      billing_name,
      paid,
      canceled,
      payment_amount,
      payment_method,
      order_date,
      payment_date,
      shipping_status,
      raw_order_data,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, NOW()
    )
    ON CONFLICT (cafe24_order_id)
    DO UPDATE SET
      shop_no = EXCLUDED.shop_no,
      member_id = EXCLUDED.member_id,
      member_email = EXCLUDED.member_email,
      billing_name = EXCLUDED.billing_name,
      paid = EXCLUDED.paid,
      canceled = EXCLUDED.canceled,
      payment_amount = EXCLUDED.payment_amount,
      payment_method = EXCLUDED.payment_method,
      order_date = EXCLUDED.order_date,
      payment_date = EXCLUDED.payment_date,
      shipping_status = EXCLUDED.shipping_status,
      raw_order_data = EXCLUDED.raw_order_data,
      updated_at = NOW()
    RETURNING *
  `;

  var values = [
    order.order_id,
    order.shop_no || null,
    order.member_id || null,
    order.member_email || null,
    order.billing_name || null,
    order.paid === 'T',
    order.canceled === 'T',
    order.payment_amount ? Number(order.payment_amount) : 0,
    JSON.stringify(order.payment_method || []),
    order.order_date || null,
    order.payment_date || null,
    order.shipping_status || null,
    JSON.stringify(order)
  ];

  return pool.query(sql, values);
}

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

  cleanupOauthStates();
  var state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { mallId: mallId, createdAt: Date.now() });

  var params = querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    state: state,
    redirect_uri: REDIRECT_URI,
    scope: 'mall.read_order'
  });

  var authorizationUrl =
    'https://' + mallId + '.cafe24api.com/api/v2/oauth/authorize?' + params;

  return res.redirect(authorizationUrl);
});

app.get('/health', function (req, res) {
  res.status(200).json({ ok: true, service: 'ScalpBorn Auto Message' });
});

app.get('/db/health', function (req, res) {
  pool.query('SELECT NOW() AS server_time, current_database() AS database_name')
    .then(function (result) {
      return res.status(200).json({
        ok: true,
        message: 'Supabase PostgreSQL 연결에 성공했습니다.',
        result: result.rows[0]
      });
    })
    .catch(function (error) {
      console.error('Database health error:', error);
      return res.status(500).json({
        ok: false,
        message: 'Supabase PostgreSQL 연결에 실패했습니다.',
        detail: error.message
      });
    });
});

app.get('/db/init', function (req, res) {
  initializeDatabase()
    .then(function () {
      return res.status(200).json({
        ok: true,
        message: 'cafe24_orders 테이블 준비가 완료되었습니다.'
      });
    })
    .catch(function (error) {
      console.error('Database initialize error:', error);
      return res.status(500).json({
        ok: false,
        message: '데이터베이스 테이블 생성에 실패했습니다.',
        detail: error.message
      });
    });
});

app.get('/oauth/status', function (req, res) {
  if (!oauthToken) {
    return res.status(401).json({
      ok: false,
      connected: false,
      message: '저장된 카페24 OAuth 토큰이 없습니다.'
    });
  }

  return res.status(200).json({
    ok: true,
    connected: true,
    mall_id: oauthToken.mallId,
    shop_no: oauthToken.shopNo,
    scopes: oauthToken.scopes,
    expires_at: oauthToken.expiresAt,
    refresh_token_expires_at: oauthToken.refreshTokenExpiresAt
  });
});

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

  var basicAuth = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');

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

  var tokenRequest = requestCafe24Api(requestOptions, function (requestError, tokenData, statusCode) {
    if (requestError) {
      console.error('Cafe24 token request error:', requestError);
      return res.status(500).json({
        ok: false,
        message: '카페24 토큰 서버 연결 중 오류가 발생했습니다.',
        detail: requestError.message
      });
    }

    if (statusCode < 200 || statusCode >= 300) {
      return res.status(statusCode).json({
        ok: false,
        message: 'Access Token 발급에 실패했습니다.',
        cafe24: tokenData
      });
    }

    oauthToken = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_at,
      refreshTokenExpiresAt: tokenData.refresh_token_expires_at,
      mallId: tokenData.mall_id || mallId,
      shopNo: tokenData.shop_no,
      scopes: tokenData.scopes
    };

    console.log('Cafe24 OAuth connected:', {
      mall_id: oauthToken.mallId,
      shop_no: oauthToken.shopNo,
      scopes: oauthToken.scopes,
      expires_at: oauthToken.expiresAt
    });

    return res.status(200).json({
      ok: true,
      message: '카페24 OAuth 연결에 성공했습니다.',
      mall_id: oauthToken.mallId,
      shop_no: oauthToken.shopNo,
      scopes: oauthToken.scopes,
      expires_at: oauthToken.expiresAt,
      refresh_token_expires_at: oauthToken.refreshTokenExpiresAt,
      next_test_url: '/test/orders',
      next_save_url: '/test/orders/save'
    });
  });

  tokenRequest.write(requestBody);
  tokenRequest.end();
});

app.get('/test/orders', function (req, res) {
  fetchRecentOrders(1, function (error, data, statusCode) {
    if (error) {
      return res.status(statusCode || 500).json({
        ok: false,
        message: error.message,
        cafe24: data || undefined
      });
    }

    return res.status(200).json({
      ok: true,
      message: '카페24 주문 조회에 성공했습니다.',
      search_period: data.searchPeriod,
      result: data.orderData
    });
  });
});

app.get('/test/orders/save', function (req, res) {
  fetchRecentOrders(1, function (error, data, statusCode) {
    if (error) {
      return res.status(statusCode || 500).json({
        ok: false,
        message: error.message,
        cafe24: data || undefined
      });
    }

    var orders = data.orderData && Array.isArray(data.orderData.orders)
      ? data.orderData.orders
      : [];

    if (orders.length === 0) {
      return res.status(404).json({
        ok: false,
        message: '저장할 카페24 주문이 없습니다.'
      });
    }

    initializeDatabase()
      .then(function () {
        return saveCafe24Order(orders[0]);
      })
      .then(function (saveResult) {
        return res.status(200).json({
          ok: true,
          message: '카페24 주문을 Supabase에 저장했습니다.',
          saved_order: saveResult.rows[0]
        });
      })
      .catch(function (saveError) {
        console.error('Cafe24 order save error:', saveError);
        return res.status(500).json({
          ok: false,
          message: '카페24 주문 저장에 실패했습니다.',
          detail: saveError.message
        });
      });
  });
});

app.post('/webhooks/cafe24', function (req, res) {
  console.log('Cafe24 Webhook received:', req.body);
  res.status(200).json({ received: true });
});

app.use(function (req, res) {
  res.status(404).json({
    ok: false,
    message: '요청한 주소를 찾을 수 없습니다.'
  });
});

module.exports = app;
