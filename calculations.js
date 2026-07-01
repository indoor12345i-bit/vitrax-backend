// ════════════════════════════════════════════════════════════════════════
// VITRAX CALCULATION ENGINE
// Identical logic to the dashboard frontend - kept in sync deliberately.
// If you change a formula here, update vitrax_final.html to match, and vice versa.
// ════════════════════════════════════════════════════════════════════════

function ema(data, p) {
  var k = 2/(p+1), e = [data[0]];
  for (var i=1; i<data.length; i++) e.push(+(data[i]*k+e[i-1]*(1-k)).toFixed(2));
  return e;
}

function rsi(data, p) {
  var r = [];
  for (var i=0; i<p; i++) r.push(null);
  for (var i=p; i<data.length; i++) {
    var g=0, l=0;
    for (var j=i-p+1; j<=i; j++) { var d=data[j]-data[j-1]; if(d>0) g+=d; else l-=d; }
    var rs = l===0 ? 100 : g/l;
    r.push(+(100-100/(1+rs)).toFixed(1));
  }
  return r;
}

function macd(data) {
  var e12 = ema(data,12), e26 = ema(data,26);
  var macdLine = e12.map(function(v,i){ return +(v-e26[i]).toFixed(2); });
  var sigLine = ema(macdLine,9);
  var hist = macdLine.map(function(v,i){ return +(v-sigLine[i]).toFixed(2); });
  return { macd: macdLine, signal: sigLine, hist: hist };
}

function bollinger(data, p) {
  p = p || 20;
  var upper=[], lower=[], mid=[];
  for (var i=0; i<data.length; i++) {
    if (i<p-1) { upper.push(null); lower.push(null); mid.push(null); continue; }
    var slice = data.slice(i-p+1, i+1);
    var sma = slice.reduce(function(a,b){return a+b;}) / p;
    var variance = slice.reduce(function(a,b){return a+Math.pow(b-sma,2);},0) / p;
    var std = Math.sqrt(variance);
    mid.push(+sma.toFixed(2));
    upper.push(+(sma+2*std).toFixed(2));
    lower.push(+(sma-2*std).toFixed(2));
  }
  return { upper: upper, lower: lower, mid: mid };
}

function stochastic(closes, highs, lows, kPeriod, dPeriod) {
  kPeriod = kPeriod || 14; dPeriod = dPeriod || 3;
  var k=[], d=[];
  for (var i=0; i<closes.length; i++) {
    if (i<kPeriod-1) { k.push(null); continue; }
    var hh = Math.max.apply(null, highs.slice(i-kPeriod+1, i+1));
    var ll = Math.min.apply(null, lows.slice(i-kPeriod+1, i+1));
    var kv = hh===ll ? 50 : +((closes[i]-ll)/(hh-ll)*100).toFixed(1);
    k.push(kv);
  }
  for (var i=0; i<k.length; i++) {
    if (i<kPeriod-1+dPeriod-1) { d.push(null); continue; }
    var valid = k.slice(i-dPeriod+1, i+1).filter(function(v){ return v!==null; });
    d.push(+(valid.reduce(function(a,b){return a+b;}) / valid.length).toFixed(1));
  }
  return { k: k, d: d };
}

// ════════════════════════════════════════════════════════════════════════
// MULTI-TIMEFRAME ANALYSIS (MTF)
//
// The single biggest upgrade to the signal system. Instead of only
// looking at the current short-term price action, MTF checks whether
// the 4-hour and daily trends agree with the short-term signal direction.
//
// Why this matters: a BUY signal on a 1h chart means very little if the
// 4h and daily charts are both in a clear downtrend. Trading counter-trend
// is the most common cause of stop-loss hits. MTF filters these out.
//
// How it works:
//   - 4h candles: is the medium-term trend (last 2 days) bullish or bearish?
//   - Daily candles: is the longer-term trend (last 2 weeks) bullish or bearish?
//   - Each timeframe votes: +1 for bullish, -1 for bearish, 0 for neutral
//   - Total MTF score: -2 (both bearish) to +2 (both bullish)
//
// Interpretation:
//   MTF score +2 → both timeframes bullish → strong confirmation for BUY
//   MTF score +1 → mixed → weak confirmation, use with caution
//   MTF score  0 → neutral → no MTF bias either way
//   MTF score -1 → mixed → weak confirmation for SELL
//   MTF score -2 → both timeframes bearish → strong confirmation for SELL
//
// A BUY signal with MTF score +2 gets full confidence boost.
// A BUY signal with MTF score -2 gets a significant confidence penalty
// because it's trading directly against both higher timeframes.
// ════════════════════════════════════════════════════════════════════════
function calcMTF(candles4h, candlesDaily) {
  var mtfScore = 0;
  var mtfReasons = [];

  // ── 4-Hour Trend Analysis ─────────────────────────────────────────────
  if (candles4h && candles4h.length >= 20) {
    var closes4h = candles4h.map(function(c) { return c.close; });
    var highs4h  = candles4h.map(function(c) { return c.high; });
    var lows4h   = candles4h.map(function(c) { return c.low; });
    var price4h  = closes4h[closes4h.length - 1];

    // EMA trend on 4h
    var ema104h = ema(closes4h, 10);
    var ema204h = ema(closes4h, 20);
    var e10v = ema104h[ema104h.length - 1];
    var e20v = ema204h[ema204h.length - 1];

    // RSI on 4h
    var rsi4hArr = rsi(closes4h, 14);
    var rsi4h = rsi4hArr[rsi4hArr.length - 1] || 50;

    // MACD on 4h
    var macd4h = macd(closes4h);
    var hist4h = macd4h.hist[macd4h.hist.length - 1];

    var votes4h = 0;
    if (price4h > e10v && e10v > e20v) { votes4h++; }   // bullish trend
    else if (price4h < e10v && e10v < e20v) { votes4h--; } // bearish trend
    if (rsi4h > 55) { votes4h++; }
    else if (rsi4h < 45) { votes4h--; }
    if (hist4h > 0) { votes4h++; }
    else if (hist4h < 0) { votes4h--; }

    if (votes4h >= 2) {
      mtfScore++;
      mtfReasons.push('4H trend: BULLISH');
    } else if (votes4h <= -2) {
      mtfScore--;
      mtfReasons.push('4H trend: BEARISH');
    } else {
      mtfReasons.push('4H trend: NEUTRAL');
    }
  }

  // ── Daily Trend Analysis ──────────────────────────────────────────────
  if (candlesDaily && candlesDaily.length >= 14) {
    var closesD = candlesDaily.map(function(c) { return c.close; });
    var highsD  = candlesDaily.map(function(c) { return c.high; });
    var lowsD   = candlesDaily.map(function(c) { return c.low; });
    var priceD  = closesD[closesD.length - 1];

    // EMA trend on daily
    var ema7d  = ema(closesD, 7);
    var ema14d = ema(closesD, 14);
    var e7v  = ema7d[ema7d.length - 1];
    var e14v = ema14d[ema14d.length - 1];

    // RSI on daily
    var rsiDArr = rsi(closesD, 14);
    var rsiD = rsiDArr[rsiDArr.length - 1] || 50;

    // Simple trend: is today's close higher or lower than 5 days ago?
    var close5ago = closesD[closesD.length - 6] || closesD[0];
    var weekTrend = priceD > close5ago ? 1 : -1;

    var votesD = 0;
    if (priceD > e7v && e7v > e14v) { votesD++; }
    else if (priceD < e7v && e7v < e14v) { votesD--; }
    if (rsiD > 55) { votesD++; }
    else if (rsiD < 45) { votesD--; }
    votesD += weekTrend;

    if (votesD >= 2) {
      mtfScore++;
      mtfReasons.push('Daily trend: BULLISH');
    } else if (votesD <= -2) {
      mtfScore--;
      mtfReasons.push('Daily trend: BEARISH');
    } else {
      mtfReasons.push('Daily trend: NEUTRAL');
    }
  }

  return { score: mtfScore, reasons: mtfReasons };
}

//
// AVWAP = Σ(typical_price × volume) / Σ(volume)
// where typical_price = (high + low + close) / 3
//
// Requires real OHLCV candle data with volume, which we pull from
// PrimaCapital's MT5 feed via MetaApi. Website-based APIs don't
// provide volume, so this only runs when MT5 candle data is available.
//
// Interpretation:
//   price > AVWAP → buyers in control since daily open → bullish bias
//   price < AVWAP → sellers in control since daily open → bearish bias
//
// Used as a confirmation filter: a BUY signal above AVWAP is more
// reliable than one below it (not fighting institutional average).
// ════════════════════════════════════════════════════════════════════════
function calcAVWAP(candles) {
  if (!candles || candles.length === 0) return null;

  // Anchor to start of current UTC trading day
  var now = new Date();
  var dayStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));

  // Only use candles from today's session
  var todayCandles = candles.filter(function(c) {
    return new Date(c.time) >= dayStart;
  });

  if (todayCandles.length === 0) {
    // If no candles yet today (market just opened), use last 20 candles
    // as a rolling approximation rather than returning null entirely
    todayCandles = candles.slice(-20);
  }

  var sumTPV = 0, sumVol = 0;
  todayCandles.forEach(function(c) {
    var typicalPrice = (c.high + c.low + c.close) / 3;
    var vol = c.volume || 1; // volume always >= 1 to avoid division issues
    sumTPV += typicalPrice * vol;
    sumVol += vol;
  });

  return sumVol > 0 ? +(sumTPV / sumVol).toFixed(2) : null;
}

function calcATR(closes, highs, lows, period) {
  period = period || 14;
  var trueRanges = [];
  for (var i=1; i<closes.length; i++) {
    var hl = highs[i]-lows[i];
    var hc = Math.abs(highs[i]-closes[i-1]);
    var lc = Math.abs(lows[i]-closes[i-1]);
    trueRanges.push(Math.max(hl,hc,lc));
  }
  var recent = trueRanges.slice(-period);
  var atr = recent.reduce(function(a,b){return a+b;},0) / recent.length;
  return +atr.toFixed(2);
}

function calcDynamicLevels(cur, sig, atr, rsiV) {
  if (sig === 'WAIT') return { tp: null, tp1: null, tp2: null, sl: null, atr: atr };
  var slMultiplier = 0.5;
  if (rsiV < 25 && sig === 'BUY') { slMultiplier = 0.4; }
  else if (rsiV > 75 && sig === 'SELL') { slMultiplier = 0.4; }
  else if (rsiV > 45 && rsiV < 55) { slMultiplier = 0.6; }

  // SL — unchanged, ATR-based
  var slDist = Math.max(Math.min(+(atr*slMultiplier).toFixed(2), 50), 5);

  // TP1 — conservative target ($9 fixed)
  var tp1Dist = 9;

  // TP2 — extended target ($18 fixed)
  var tp2Dist = 18;

  var tp1, tp2, sl;
  if (sig === 'BUY') {
    tp1 = +(cur + tp1Dist).toFixed(2);
    tp2 = +(cur + tp2Dist).toFixed(2);
    sl  = +(cur - slDist).toFixed(2);
  } else {
    tp1 = +(cur - tp1Dist).toFixed(2);
    tp2 = +(cur - tp2Dist).toFixed(2);
    sl  = +(cur + slDist).toFixed(2);
  }

  return {
    tp: tp1,       // backwards compat — tp still points to TP1
    tp1: tp1,
    tp2: tp2,
    sl: sl,
    atr: atr,
    slDist: slDist,
    tp1Dist: tp1Dist,
    tp2Dist: tp2Dist,
    rr: +(tp2Dist / slDist).toFixed(1) // RR based on TP2
  };
}

function choppy(closes) {
  var ch = [];
  for (var i=1; i<closes.length; i++) ch.push(Math.abs(closes[i]-closes[i-1]));
  var avg = ch.reduce(function(a,b){return a+b;},0) / ch.length;
  var rec = ch.slice(-5).reduce(function(a,b){return a+b;},0) / 5;
  return rec < avg*0.5;
}

function calcFearGreed(closes, rsiVal, bollData, macdData) {
  var scores = [rsiVal];
  var momentum = ((closes[closes.length-1]-closes[0]) / closes[0]) * 100;
  scores.push(Math.min(100, Math.max(0, 50+momentum*5)));
  var changes = [];
  for (var i=1; i<closes.length; i++) changes.push(Math.abs(closes[i]-closes[i-1]));
  var avgVol = changes.reduce(function(a,b){return a+b;}) / changes.length;
  var recentVol = changes.slice(-5).reduce(function(a,b){return a+b;},0) / 5;
  scores.push(recentVol > avgVol ? 30 : 70);
  if (bollData && bollData.upper[bollData.upper.length-1]) {
    var cur = closes[closes.length-1];
    var upper = bollData.upper[bollData.upper.length-1];
    var lower = bollData.lower[bollData.lower.length-1];
    var range = upper-lower;
    scores.push(Math.min(100, Math.max(0, range>0 ? ((cur-lower)/range)*100 : 50)));
  }
  if (macdData) scores.push(macdData.hist[macdData.hist.length-1] > 0 ? 65 : 35);
  return Math.round(scores.reduce(function(a,b){return a+b;}) / scores.length);
}

function detectCandlePattern(closes, highs, lows) {
  var n = closes.length;
  var c = closes[n-1], p = closes[n-2];
  var h = highs[n-1], l = lows[n-1];
  var body = Math.abs(c-p);
  var totalRange = h-l;
  var upperWick = h - Math.max(c,p);
  var lowerWick = Math.min(c,p) - l;
  if (lowerWick > body*2 && upperWick < body*0.5 && c < closes[n-5]) return {name:'Hammer', signal:'BUY'};
  if (upperWick > body*2 && lowerWick < body*0.5 && c > closes[n-5]) return {name:'Shooting Star', signal:'SELL'};
  if (body < totalRange*0.1) return {name:'Doji', signal:'NEUTRAL'};
  if (c>p && body>totalRange*0.7) return {name:'Strong Bull Candle', signal:'BUY'};
  if (c<p && body>totalRange*0.7) return {name:'Strong Bear Candle', signal:'SELL'};
  return {name:'No Pattern', signal:'NEUTRAL'};
}

function detectSession() {
  var now = new Date();
  var lebHour = (now.getUTCHours()+3) % 24;
  if (lebHour>=10 && lebHour<19) return { session:'London', confidence:5 };
  if (lebHour>=16 && lebHour<24) return { session:'New York', confidence:4 };
  if (lebHour>=1 && lebHour<10) return { session:'Asian', confidence:-2 };
  return { session:'Quiet', confidence:-5 };
}

function detectWhale(closes) {
  var n = closes.length;
  var moves = [];
  for (var i=1; i<n; i++) moves.push(Math.abs(closes[i]-closes[i-1]));
  var avgMove = moves.reduce(function(a,b){return a+b;}) / moves.length;
  var lastMove = moves[moves.length-1];
  return lastMove > avgMove*2.5;
}

function detectStopHunt(closes, lows) {
  var n = closes.length;
  var prevLow = Math.min.apply(null, lows.slice(-10,-5));
  var currentClose = closes[n-1];
  var currentLow = lows[n-1];
  var spikedBelow = currentLow < prevLow*0.998;
  var recovered = currentClose > currentLow + (closes[n-1]-currentLow)*0.6;
  return spikedBelow && recovered;
}

function displayDXY(closes) {
  var goldChange = ((closes[closes.length-1]-closes[0]) / closes[0]) * 100;
  var dxyEstimate = -goldChange*0.7;
  return dxyEstimate>0.3 ? -1 : dxyEstimate<-0.3 ? 1 : 0;
}

var BULLISH_KEYWORDS = ['war','conflict','crisis','fear','inflation','recession','geopolitical','tension','sanctions','safe haven','gold rally','gold rises','dollar falls','fed cuts','rate cut'];
var BEARISH_KEYWORDS = ['rate hike','fed raises','dollar rises','strong jobs','low inflation','recovery','gold falls','gold drops','gold plunges'];

function analyzeNewsSentiment(articles) {
  var bullScore=0, bearScore=0;
  articles.forEach(function(a) {
    var text = ((a.title||'')+' '+(a.description||'')).toLowerCase();
    BULLISH_KEYWORDS.forEach(function(kw){ if(text.indexOf(kw)!==-1) bullScore++; });
    BEARISH_KEYWORDS.forEach(function(kw){ if(text.indexOf(kw)!==-1) bearScore++; });
  });
  var total = bullScore+bearScore;
  var score = total>0 ? ((bullScore-bearScore)/total)*100 : 0;
  return { score: Math.round(score), bullScore: bullScore, bearScore: bearScore,
    signal: score>20?'BUY':score<-20?'SELL':'NEUTRAL' };
}

var ECON_EVENTS = [
  {day:1, month:7, time:'15:00', name:'US ISM Manufacturing PMI', impact:'HIGH', goldEffect:'bearish if strong'},
  {day:4, month:7, time:'15:30', name:'US Non-Farm Payrolls (NFP)', impact:'HIGH', goldEffect:'bearish if strong'},
  {day:10, month:7, time:'15:30', name:'US CPI Inflation', impact:'HIGH', goldEffect:'bullish if high'},
  {day:16, month:7, time:'18:00', name:'Fed Interest Rate Decision', impact:'CRITICAL', goldEffect:'bearish if hike'},
  {day:25, month:7, time:'15:30', name:'US GDP Growth', impact:'HIGH', goldEffect:'bearish if strong'},
  {day:30, month:7, time:'15:30', name:'US Core PCE Inflation', impact:'HIGH', goldEffect:'bullish if high'},
];

function checkEconEvent() {
  var now = new Date();
  return ECON_EVENTS.find(function(e) {
    return e.day===now.getDate() && e.month===(now.getMonth()+1) && e.impact!=='LOW';
  });
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL SCORING — combines all layers into one BUY/SELL/WAIT
// ════════════════════════════════════════════════════════════════════════
function calcSignal(closes, highs, lows, newsSentiment, candles, candles4h, candlesDaily) {
  var e14arr = ema(closes,14), e25arr = ema(closes,25);
  var rsiArr = rsi(closes,14);
  var e14v = e14arr[e14arr.length-1], e25v = e25arr[e25arr.length-1];
  var rsiV = rsiArr[rsiArr.length-1]||50;
  var macdData = macd(closes);
  var bollData = bollinger(closes,20);
  var stochData = stochastic(closes,highs,lows,14,3);
  var p = closes[closes.length-1];

  var score = 0, reasons = [];

  if (newsSentiment) {
    if (newsSentiment.signal === 'BUY') { score+=2; reasons.push('News bullish'); }
    else if (newsSentiment.signal === 'SELL') { score-=2; reasons.push('News bearish'); }
  }
  if (p>e14v) { score++; reasons.push('Price above EMA14'); } else { score--; reasons.push('Price below EMA14'); }
  if (e14v>e25v) { score++; reasons.push('Golden cross'); } else { score--; reasons.push('Death cross'); }
  if (rsiV<30) { score+=2; reasons.push('RSI oversold'); }
  else if (rsiV>70) { score-=2; reasons.push('RSI overbought'); }
  else if (rsiV>=40 && rsiV<=60) { score++; reasons.push('RSI neutral-bullish'); }

  var lastHist = macdData.hist[macdData.hist.length-1];
  var prevHist = macdData.hist[macdData.hist.length-2];
  if (lastHist>0 && lastHist>prevHist) { score++; reasons.push('MACD bullish momentum'); }
  else if (lastHist<0 && lastHist<prevHist) { score--; reasons.push('MACD bearish momentum'); }

  var upper = bollData.upper[bollData.upper.length-1];
  var lower = bollData.lower[bollData.lower.length-1];
  if (p<=lower) { score+=2; reasons.push('Price at lower Bollinger'); }
  else if (p>=upper) { score-=2; reasons.push('Price at upper Bollinger'); }

  var kv = stochData.k[stochData.k.length-1];
  var dv = stochData.d[stochData.d.length-1];
  if (kv<20 && dv<20) { score+=2; reasons.push('Stochastic oversold'); }
  else if (kv>80 && dv>80) { score-=2; reasons.push('Stochastic overbought'); }

  // ── AVWAP (Anchored VWAP) — only when real MT5 candle data is available ──
  // Price above daily AVWAP = buyers in control since daily open = bullish
  // Price below daily AVWAP = sellers in control since daily open = bearish
  // Acts as a confirmation filter: BUY above AVWAP is more reliable than
  // BUY below it, since we'd be trading WITH institutional order flow.
  var avwapValue = candles ? calcAVWAP(candles) : null;
  if (avwapValue !== null) {
    if (p > avwapValue) {
      score++;
      reasons.push('Price above daily AVWAP ($' + avwapValue + ')');
    } else if (p < avwapValue) {
      score--;
      reasons.push('Price below daily AVWAP ($' + avwapValue + ')');
    }
  }

  // ── MTF (Multi-Timeframe Analysis) ───────────────────────────────────
  // The most important filter: does the 4h and daily trend agree with
  // the short-term signal direction? Trading with higher timeframes
  // dramatically increases the chance of hitting take profit.
  var mtfResult = calcMTF(candles4h, candlesDaily);
  var mtfScore = mtfResult.score;
  var mtfReasons = mtfResult.reasons;

  // MTF contributes to the signal score — but with higher weight than
  // most individual indicators because it represents an independent,
  // broader market perspective that the short-term indicators can't see.
  if (mtfScore >= 2) {
    score += 2;
    reasons.push('MTF confirmed: ' + mtfReasons.join(' | '));
  } else if (mtfScore === 1) {
    score++;
    reasons.push('MTF partial bullish: ' + mtfReasons.join(' | '));
  } else if (mtfScore === -1) {
    score--;
    reasons.push('MTF partial bearish: ' + mtfReasons.join(' | '));
  } else if (mtfScore <= -2) {
    score -= 2;
    reasons.push('MTF confirmed bearish: ' + mtfReasons.join(' | '));
  } else {
    reasons.push('MTF neutral: ' + mtfReasons.join(' | '));
  }

  var label, dir, strength = '';
  if (score>=4) { label='BUY'; dir='LONG'; strength='STRONG'; }
  else if (score>=2) { label='BUY'; dir='LONG'; strength='MODERATE'; }
  else if (score<=-4) { label='SELL'; dir='SHORT'; strength='STRONG'; }
  else if (score<=-2) { label='SELL'; dir='SHORT'; strength='MODERATE'; }
  else { label='WAIT'; dir='NEUTRAL'; }

  var atrValue = calcATR(closes, highs, lows, 14);
  var levels = calcDynamicLevels(p, label, atrValue, rsiV);
  var fgScore = calcFearGreed(closes, rsiV, bollData, macdData);
  var pattern = detectCandlePattern(closes, highs, lows);
  var sessionInfo = detectSession();
  var whaleDetected = detectWhale(closes);
  var stopHunt = detectStopHunt(closes, lows);
  var dxyScore = displayDXY(closes);
  var hasEvent = !!checkEconEvent();
  var isChoppy = choppy(closes);

  var base = 50 + (Math.abs(score)/6)*20;
  var adj = 0;
  if (fgScore<=30 && label==='BUY') adj+=5;
  if (fgScore>=70 && label==='SELL') adj+=5;
  if (!hasEvent) adj+=3; else adj-=8;
  if (!whaleDetected) adj+=3; else adj-=5;
  if (!stopHunt) adj+=2; else adj-=3;
  adj += sessionInfo.confidence;
  if (dxyScore!==0 && ((dxyScore>0 && label==='BUY')||(dxyScore<0 && label==='SELL'))) adj+=3;
  if (pattern.signal===label) adj+=4;
  // AVWAP confirmation boosts confidence when aligned, reduces when against
  if (avwapValue !== null) {
    if ((label==='BUY' && p > avwapValue) || (label==='SELL' && p < avwapValue)) adj+=5;
    else if ((label==='BUY' && p < avwapValue) || (label==='SELL' && p > avwapValue)) adj-=7;
  }
  // MTF confidence adjustment — the most powerful confidence modifier
  // Trading WITH both higher timeframes = big boost
  // Trading AGAINST both higher timeframes = big penalty
  if (mtfScore >= 2) {
    if ((label==='BUY' && mtfScore > 0) || (label==='SELL' && mtfScore < 0)) adj += 10;
    else adj -= 10;
  } else if (mtfScore === 1) {
    if ((label==='BUY') || (label==='SELL' && mtfScore < 0)) adj += 5;
    else adj -= 5;
  } else if (mtfScore === -1) {
    if (label==='SELL') adj += 5;
    else adj -= 5;
  } else if (mtfScore <= -2) {
    if (label==='SELL') adj += 10;
    else adj -= 10;
  }
  var confidence = Math.min(85, Math.max(30, Math.round(base+adj)));

  return {
    label: label, direction: dir, strength: strength, score: score, reasons: reasons,
    entry: p, takeProfit: levels.tp1, takeProfit2: levels.tp2, stopLoss: levels.sl, atr: atrValue, riskReward: levels.rr,
    rsi: rsiV, ema14: e14v, ema25: e25v, confidence: confidence,
    fearGreed: fgScore, candlePattern: pattern.name, session: sessionInfo.session,
    whaleDetected: whaleDetected, stopHuntDetected: stopHunt, isChoppy: isChoppy,
    hasEconEvent: hasEvent, dxyScore: dxyScore, avwap: avwapValue,
    mtfScore: mtfScore, mtfReasons: mtfReasons
  };
}

// ════════════════════════════════════════════════════════════════════════
// EMERGENCY CHECK
// ════════════════════════════════════════════════════════════════════════
function checkEmergencyTrigger(closes, highs, lows, newsSentiment, candles) {
  if (!closes || closes.length < 8) return null; // need more history for confirmation

  var price = closes[closes.length-1];
  var prevPrice = closes[closes.length-2];
  var priceMove = Math.abs(price - prevPrice);
  var reasons = [], emergencyScore = 0, sig = null;
  var atrVal = calcATR(closes, highs, lows, 14);
  var rsiArr = rsi(closes, 14);
  var rsiV = rsiArr[rsiArr.length-1] || 50;
  var bollData = bollinger(closes, 20);
  var macdData = macd(closes);
  var fgScore = calcFearGreed(closes, rsiV, bollData, macdData);

  // ── CHANGE 1: Raised threshold from 0.8x ATR to 2x ATR ──────────────
  // A move of 0.8x ATR is essentially a normal candle. We only want to
  // fire on genuinely exceptional moves - 2x ATR is a real, unusual spike.
  if (priceMove > atrVal * 2.0) {
    reasons.push('Large price move: $' + priceMove.toFixed(2));
    emergencyScore += 30;
    sig = price > prevPrice ? 'BUY' : 'SELL';
  }

  // ── CHANGE 2: Multi-candle confirmation ──────────────────────────────
  // A single candle breaking a level proves nothing - require the price
  // to have held the direction consistently over the last 3 candles before
  // calling it a genuine breakout rather than a spike reversal.
  var last3 = closes.slice(-4); // 4 candles: 3 moves
  var allUp = last3.every(function(c, i) { return i === 0 || c >= last3[i-1]; });
  var allDown = last3.every(function(c, i) { return i === 0 || c <= last3[i-1]; });

  if (rsiV > 85) { // Raised from 80 to 85 - truly extreme only
    reasons.push('RSI extremely overbought (' + rsiV.toFixed(1) + ')');
    emergencyScore += 25;
    sig = sig || 'SELL';
  } else if (rsiV < 15) { // Raised from 20 to 15
    reasons.push('RSI extremely oversold (' + rsiV.toFixed(1) + ')');
    emergencyScore += 25;
    sig = sig || 'BUY';
  }

  var upper = bollData.upper[bollData.upper.length-1];
  var lower = bollData.lower[bollData.lower.length-1];

  // ── CHANGE 3: Require directional confirmation for Bollinger breaks ──
  // Price breaking above upper band while 3 consecutive candles are rising
  // is more reliable than a single candle spike above the band.
  if (price > upper && allUp) {
    reasons.push('Confirmed break above Bollinger upper (3 candles up)');
    emergencyScore += 25;
    sig = sig || 'SELL'; // overbought - potential reversal sell
  } else if (price < lower && allDown) {
    reasons.push('Confirmed break below Bollinger lower (3 candles down)');
    emergencyScore += 25;
    sig = sig || 'BUY'; // oversold - potential reversal buy
  } else if (price > upper || price < lower) {
    // Single-candle Bollinger break without confirmation - much lower weight
    reasons.push('Bollinger break (unconfirmed - single candle)');
    emergencyScore += 8; // was 25, now only counts minimally
  }

  if (fgScore <= 10) { // Raised from 15 to 10
    reasons.push('Extreme fear index (' + fgScore + ')');
    emergencyScore += 15;
    sig = sig || 'BUY';
  } else if (fgScore >= 90) { // Raised from 85 to 90
    reasons.push('Extreme greed index (' + fgScore + ')');
    emergencyScore += 15;
    sig = sig || 'SELL';
  }

  var criticalEvent = checkEconEvent();
  if (criticalEvent && criticalEvent.impact === 'CRITICAL') {
    reasons.push('CRITICAL event today: ' + criticalEvent.name);
    emergencyScore += 20;
    sig = sig || (criticalEvent.goldEffect.indexOf('bullish') !== -1 ? 'BUY' : 'SELL');
  }

  // ── CHANGE 4: Raised minimum threshold from 45 to 75 ─────────────────
  // The old threshold (45) fired on just a price move + Bollinger break
  // happening simultaneously on the same spike - exactly the fake-out
  // pattern we kept seeing. 75 requires genuinely multiple independent
  // conditions to align, not two things caused by the same single candle.
  //
  // Also require at least 3 distinct reasons (not just 2) before firing.
  if (emergencyScore >= 75 && sig && reasons.length >= 3) {
    var levels = calcDynamicLevels(price, sig, atrVal, rsiV);

    // ── AVWAP directional filter ──────────────────────────────────────
    // If we have real MT5 candle data, check that the emergency signal
    // direction agrees with the daily AVWAP. A BUY signal when price is
    // below AVWAP (fighting institutional sellers) is significantly less
    // reliable than one where price is above AVWAP (going with them).
    // We don't block the signal entirely, but reduce confidence sharply
    // when going against AVWAP, since that's one of the main fake-out
    // patterns we observed in production.
    var avwapValue = candles ? calcAVWAP(candles) : null;
    var confidence = Math.min(75, 40 + emergencyScore * 0.5);

    if (avwapValue !== null) {
      var withAVWAP = (sig === 'BUY' && price > avwapValue) ||
                      (sig === 'SELL' && price < avwapValue);
      var againstAVWAP = (sig === 'BUY' && price < avwapValue) ||
                         (sig === 'SELL' && price > avwapValue);

      if (withAVWAP) {
        confidence = Math.min(75, confidence + 5);
        reasons.push('Confirmed by daily AVWAP ($' + avwapValue + ')');
      } else if (againstAVWAP) {
        confidence = Math.max(30, confidence - 15);
        reasons.push('⚠️ Against daily AVWAP ($' + avwapValue + ') — reduced confidence');
      }
    }

    return {
      signal: sig, entry: price, takeProfit: levels.tp1, takeProfit2: levels.tp2, stopLoss: levels.sl,
      confidence: Math.round(confidence), reasons: reasons
    };
  }
  return null;
}

module.exports = {
  ema, rsi, macd, bollinger, stochastic, calcATR, calcDynamicLevels, choppy,
  calcFearGreed, detectCandlePattern, detectSession, detectWhale, detectStopHunt,
  displayDXY, analyzeNewsSentiment, checkEconEvent, calcSignal, checkEmergencyTrigger, calcAVWAP, calcMTF,
  ECON_EVENTS
};
