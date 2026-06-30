// ════════════════════════════════════════════════════════════════════════
// MT5 LIVE PRICE FEED — direct connection to PrimaCapital via MetaApi
//
// This replaces the old website-based live ticker (gold-api.com, GoldAPI.io)
// which was confirmed today to sometimes return prices $30+ off from the
// real broker feed. This connects directly to the actual MT5 account,
// pulling the exact same price PrimaCapital's own terminal shows.
//
// Confirmed working via standalone test on 2026-06-30: real price
// ($4023.39) matched the live MT5 app screenshot ($4023.91) within
// normal price movement over a few minutes.
// ════════════════════════════════════════════════════════════════════════
const MetaApi = require('metaapi.cloud-sdk').default;

const TOKEN = process.env.METAAPI_TOKEN || 'eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiJiOGNmYmJiN2Q5YjY3YzE1ZmY5ZjIwMGE4MDlhNzAxZCIsImFjY2Vzc1J1bGVzIjpbeyJpZCI6InRyYWRpbmctYWNjb3VudC1tYW5hZ2VtZW50LWFwaSIsIm1ldGhvZHMiOlsidHJhZGluZy1hY2NvdW50LW1hbmFnZW1lbnQtYXBpOnJlc3Q6cHVibGljOio6KiJdLCJyb2xlcyI6WyJyZWFkZXIiLCJ3cml0ZXIiXSwicmVzb3VyY2VzIjpbIio6JFVTRVJfSUQkOioiXX0seyJpZCI6Im1ldGFhcGktcmVzdC1hcGkiLCJtZXRob2RzIjpbIm1ldGFhcGktYXBpOnJlc3Q6cHVibGljOio6KiJdLCJyb2xlcyI6WyJyZWFkZXIiLCJ3cml0ZXIiXSwicmVzb3VyY2VzIjpbIio6JFVTRVJfSUQkOioiXX0seyJpZCI6Im1ldGFhcGktcnBjLWFwaSIsIm1ldGhvZHMiOlsibWV0YWFwaS1hcGk6d3M6cHVibGljOio6KiJdLCJyb2xlcyI6WyJyZWFkZXIiLCJ3cml0ZXIiXSwicmVzb3VyY2VzIjpbIio6JFVTRVJfSUQkOioiXX0seyJpZCI6Im1ldGFhcGktcmVhbC10aW1lLXN0cmVhbWluZy1hcGkiLCJtZXRob2RzIjpbIm1ldGFhcGktYXBpOndzOnB1YmxpYzoqOioiXSwicm9sZXMiOlsicmVhZGVyIiwid3JpdGVyIl0sInJlc291cmNlcyI6WyIqOiRVU0VSX0lEJDoqIl19LHsiaWQiOiJtZXRhc3RhdHMtYXBpIiwibWV0aG9kcyI6WyJtZXRhc3RhdHMtYXBpOnJlc3Q6cHVibGljOio6KiJdLCJyb2xlcyI6WyJyZWFkZXIiLCJ3cml0ZXIiXSwicmVzb3VyY2VzIjpbIio6JFVTRVJfSUQkOioiXX0seyJpZCI6InJpc2stbWFuYWdlbWVudC1hcGkiLCJtZXRob2RzIjpbInJpc2stbWFuYWdlbWVudC1hcGk6cmVzdDpwdWJsaWM6KjoqIl0sInJvbGVzIjpbInJlYWRlciIsIndyaXRlciJdLCJyZXNvdXJjZXMiOlsiKjokVVNFUl9JRCQ6KiJdfSx7ImlkIjoiY29weWZhY3RvcnktYXBpIiwibWV0aG9kcyI6WyJjb3B5ZmFjdG9yeS1hcGk6cmVzdDpwdWJsaWM6KjoqIl0sInJvbGVzIjpbInJlYWRlciIsIndyaXRlciJdLCJyZXNvdXJjZXMiOlsiKjokVVNFUl9JRCQ6KiJdfSx7ImlkIjoibXQtbWFuYWdlci1hcGkiLCJtZXRob2RzIjpbIm10LW1hbmFnZXItYXBpOnJlc3Q6ZGVhbGluZzoqOioiLCJtdC1tYW5hZ2VyLWFwaTpyZXN0OnB1YmxpYzoqOioiXSwicm9sZXMiOlsicmVhZGVyIiwid3JpdGVyIl0sInJlc291cmNlcyI6WyIqOiRVU0VSX0lEJDoqIl19LHsiaWQiOiJiaWxsaW5nLWFwaSIsIm1ldGhvZHMiOlsiYmlsbGluZy1hcGk6cmVzdDpwdWJsaWM6KjoqIl0sInJvbGVzIjpbInJlYWRlciJdLCJyZXNvdXJjZXMiOlsiKjokVVNFUl9JRCQ6KiJdfV0sImlnbm9yZVJhdGVMaW1pdHMiOmZhbHNlLCJ0b2tlbklkIjoiMjAyMTAyMTMiLCJpbXBlcnNvbmF0ZWQiOmZhbHNlLCJyZWFsVXNlcklkIjoiYjhjZmJiYjdkOWI2N2MxNWZmOWYyMDBhODA5YTcwMWQiLCJpYXQiOjE3ODI4MTkzNzYsImV4cCI6MTc5MDU5NTM3Nn0.bgo9ZlcOw86iBag2y1JW8prePgg6KBmdtByRQuFbnRidls_hIysMBVFD1ZFSp4I0WBpQpbF-qhFJu1FF92MbILSx12MubW8HnxF5jt4j6iMv79yfeCxygtsPWSq6bjrdS-FFDitovf7BruV8OMSp-fln1U9rfxIZ2n97OtCfAbGu0DjuxYUB0BoQx1O9BY5D_HVFIJ5-4YDeHLKevcsOp3AQ84u2lPmHwAaQfoWPQAw6s_62B2jOveAXmFVtoPeAyaI8rdbPe51BBF0YAx2x-35AS-tGOzw9IOk3aKjtlPZGbg8MHem0TXjacvam1r-FwjRpEAZzfP9SOvu4iwRd3MvlmODUDRUbSw0Mwp4vTwUGo0r_z_1m6ZtNjVRxzxLworuhpboQcQZtfjaoxhP9nEIvC54h1sofxuK4bfIdwLW5MWGKWNfwRMuoiWIusgdjnomJqx0YslDZRzhyAy3fD5NwXlRFO70HUMHxOHp8XeImMqtLAAqDTxAh3frA7iM76X-qDYfwNJVRa2d9hJY00R7xtBTern4JGNqNz91Z3bF9EoPND094aYKmf2wn_4j8s8Z7grs0xC8_rLnXuj_3UKeUWYN_svNUpQr58ByNlFcp-eqeBxHY5vvZD7YWQ1DWGeLzO2i1Xul8oAuaoSx2IFa8Zc8zGrDBDcdLMj_MCWo';
const LOGIN = process.env.MT5_LOGIN || '40815';
const PASSWORD = process.env.MT5_PASSWORD || 'sDAa!78gdB';
const SERVER = process.env.MT5_SERVER || 'PrimaCapital-Server';
const SYMBOL = 'XAUUSD-'; // Confirmed exact symbol from PrimaCapital's MT5 Market Watch

// Cached connection - we don't want to re-establish this on every price
// request, since deployment/connection/sync takes real time. Connect once,
// keep the connection alive, reuse it for all subsequent price reads.
let cachedConnection = null;
let cachedApi = null;
let connectionPromise = null;

async function getConnection() {
  if (cachedConnection) {
    return cachedConnection;
  }

  // If a connection attempt is already in progress, wait for that one
  // instead of starting a second concurrent attempt
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    console.log('[MT5] Establishing connection to PrimaCapital via MetaApi...');
    cachedApi = new MetaApi(TOKEN);

    const accounts = await cachedApi.metatraderAccountApi.getAccountsWithInfiniteScrollPagination();
    let account = accounts.find(a => a.login === LOGIN && a.server === SERVER);

    if (!account) {
      console.log('[MT5] No existing account found, creating new one...');
      account = await cachedApi.metatraderAccountApi.createAccount({
        name: 'Vitrax Gold Price Feed',
        type: 'cloud',
        login: LOGIN,
        password: PASSWORD,
        server: SERVER,
        platform: 'mt5',
        magic: 0,
      });
    }

    if (account.state !== 'DEPLOYED' && account.state !== 'DEPLOYING') {
      console.log('[MT5] Deploying account...');
      await account.deploy();
    }

    await account.waitConnected();

    const connection = account.getStreamingConnection();
    await connection.connect();
    await connection.waitSynchronized();

    // Known MetaApi timing gap - settle before subscribing
    await new Promise(resolve => setTimeout(resolve, 10000));

    let subscribed = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await connection.subscribeToMarketData(SYMBOL);
        subscribed = true;
        break;
      } catch (err) {
        lastError = err;
        const waitSeconds = attempt * 10;
        console.log(`[MT5] Subscription attempt ${attempt}/5 failed: ${err.message}`);
        if (attempt < 5) {
          await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        }
      }
    }

    if (!subscribed) {
      throw new Error(`MT5 subscription failed after 5 attempts: ${lastError.message}`);
    }

    console.log('[MT5] ✅ Connected and subscribed to', SYMBOL);
    cachedConnection = connection;
    return connection;
  })();

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

async function fetchMT5Price() {
  try {
    const connection = await getConnection();
    const price = connection.terminalState.price(SYMBOL);

    if (!price || !price.bid) {
      console.log('[MT5] No price data available yet from terminal state');
      return null;
    }

    return {
      price: price.bid,
      bid: price.bid,
      ask: price.ask,
      source: 'PrimaCapital MT5 (direct)',
      time: price.time
    };
  } catch (err) {
    console.error('[MT5] Price fetch failed:', err.message);
    // If the connection itself failed, clear the cache so the next call
    // attempts a fresh connection rather than repeatedly failing on a
    // broken cached one.
    cachedConnection = null;
    return null;
  }
}

module.exports = { fetchMT5Price };
