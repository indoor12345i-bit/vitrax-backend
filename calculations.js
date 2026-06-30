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
  if (sig === 'WAIT') return { tp: null, sl: null, atr: atr };
  var slMultiplier = 0.5, tpMultiplier = 1.0;
  if (rsiV < 25 && sig === 'BUY') { slMultiplier = 0.4; tpMultiplier = 1.2; }
  else if (rsiV > 75 && sig === 'SELL') { slMultiplier = 0.4; tpMultiplier = 1.2; }
  else if (rsiV > 45 && rsiV < 55) { slMultiplier = 0.6; tpMultiplier = 0.9; }
  var slDist = Math.max(Math.min(+(atr*slMultiplier).toFixed(2), 50), 5);
  var tpDist = Math.max(Math.min(+(atr*tpMultiplier).toFixed(2), 80), 8);
  var tp, sl;
  if (sig === 'BUY') { tp = +(cur+tpDist).toFixed(2); sl = +(cur-slDist).toFixed(2); }
  else { tp = +(cur-tpDist).toFixed(2); sl = +(cur+slDist).toFixed(2); }
  return { tp: tp, sl: sl, atr: atr, slDist: slDist, tpDist: tpDist, rr: +(tpDist/slDist).toFixed(1) };
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
function calcSignal(closes, highs, lows, newsSentiment) {
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
  var confidence = Math.min(85, Math.max(30, Math.round(base+adj)));

  return {
    label: label, direction: dir, strength: strength, score: score, reasons: reasons,
    entry: p, takeProfit: levels.tp, stopLoss: levels.sl, atr: atrValue, riskReward: levels.rr,
    rsi: rsiV, ema14: e14v, ema25: e25v, confidence: confidence,
    fearGreed: fgScore, candlePattern: pattern.name, session: sessionInfo.session,
    whaleDetected: whaleDetected, stopHuntDetected: stopHunt, isChoppy: isChoppy,
    hasEconEvent: hasEvent, dxyScore: dxyScore
  };
}

// ════════════════════════════════════════════════════════════════════════
// EMERGENCY CHECK
// ════════════════════════════════════════════════════════════════════════
function checkEmergencyTrigger(closes, highs, lows, newsSentiment) {
  if (!closes || closes.length<5) return null;
  var price = closes[closes.length-1];
  var prevPrice = closes[closes.length-2];
  var priceMove = Math.abs(price-prevPrice);
  var reasons = [], emergencyScore = 0, sig = null;
  var atrVal = calcATR(closes, highs, lows, 14);
  var rsiArr = rsi(closes, 14);
  var rsiV = rsiArr[rsiArr.length-1] || 50;
  var bollData = bollinger(closes, 20);
  var macdData = macd(closes);
  var fgScore = calcFearGreed(closes, rsiV, bollData, macdData);

  if (priceMove > atrVal*0.8) {
    reasons.push('Large price move: $'+priceMove.toFixed(2));
    emergencyScore += 30; sig = price>prevPrice ? 'BUY' : 'SELL';
  }
  if (rsiV>80) { reasons.push('RSI extremely overbought'); emergencyScore+=25; sig=sig||'SELL'; }
  else if (rsiV<20) { reasons.push('RSI extremely oversold'); emergencyScore+=25; sig=sig||'BUY'; }

  var upper = bollData.upper[bollData.upper.length-1];
  var lower = bollData.lower[bollData.lower.length-1];
  if (price>upper) { reasons.push('Broke above Bollinger upper'); emergencyScore+=25; sig=sig||'SELL'; }
  else if (price<lower) { reasons.push('Broke below Bollinger lower'); emergencyScore+=25; sig=sig||'BUY'; }

  if (fgScore<=15) { reasons.push('Extreme fear index'); emergencyScore+=15; sig=sig||'BUY'; }
  else if (fgScore>=85) { reasons.push('Extreme greed index'); emergencyScore+=15; sig=sig||'SELL'; }

  var criticalEvent = checkEconEvent();
  if (criticalEvent && criticalEvent.impact === 'CRITICAL') {
    reasons.push('CRITICAL event today: '+criticalEvent.name);
    emergencyScore += 20;
    sig = sig || (criticalEvent.goldEffect.indexOf('bullish')!==-1 ? 'BUY' : 'SELL');
  }

  if (emergencyScore>=45 && sig && reasons.length>=2) {
    var levels = calcDynamicLevels(price, sig, atrVal, rsiV);
    return {
      signal: sig, entry: price, takeProfit: levels.tp, stopLoss: levels.sl,
      confidence: Math.min(85, 50+emergencyScore), reasons: reasons
    };
  }
  return null;
}

module.exports = {
  ema, rsi, macd, bollinger, stochastic, calcATR, calcDynamicLevels, choppy,
  calcFearGreed, detectCandlePattern, detectSession, detectWhale, detectStopHunt,
  displayDXY, analyzeNewsSentiment, checkEconEvent, calcSignal, checkEmergencyTrigger,
  ECON_EVENTS
};
