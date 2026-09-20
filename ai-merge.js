/* =====================================================================
   SAHAYAK — AI DUPLICATE-MERGE MODULE  (drop-in, zero dependencies)
   ---------------------------------------------------------------------
   WHAT IT DOES:
   When several citizens report the SAME event with slightly different
   words ("Accident near DDU." vs "Truck crashed outside DDU."), the AI
   merges them into ONE incident — based on EMERGENCY TYPE + LOCATION
   + TIME closeness.

   HOW TO ADD (does not disturb any other code):
   1. Paste this file into your project and load it BEFORE your
      dispatcher script:
          <script src="ai-merge.js"></script>
   2. In the ONE place where your dispatcher turns a citizen report
      into a NEW incident, wrap it with this:

          var decision = AIMerge.decide(report, incidents);
          if (decision.merge) {
            AIMerge.mergeInto(decision.target, report, decision.reason);
            // -> nothing else to do, NO new incident created
          } else {
            ...your existing "create new incident" code, unchanged...
          }

   That's the only change. Everything else in your dispatcher stays
   exactly as it is.
   ===================================================================== */
var AIMerge = (function () {
  "use strict";

  /* ---------- tuning (only 1 knob you may ever need) ---------- */
  var THRESHOLD = 0.62;   // match score needed to merge (0..1)

  /* ---------- emergency types: different words -> same type ---------- */
  var TYPES = {
    "Road accident": ["accident","crash","crashed","collision","collided","truck","bus","car","bike","scooter","auto","rickshaw","lorry","vehicle","train","derail","overturned","skid","rammed"],
    "Fire":          ["fire","burning","burn","burnt","smoke","flames","blaze","explosion","blast","exploded"],
    "Medical":       ["medical","heart","unconscious","bleeding","injured","injury","fainted","breathing","stroke","fracture","collapsed","chest pain","patient"],
    "Flood":         ["flood","flooded","water","overflow","submerged","drowning","waterlogging","heavy rain"],
    "Gas leak":      ["gas","leak","leaking","lpg","cylinder","fumes"],
    "Collapse":      ["collapse","collapsed","fell","debris","cracked"],
    "Crime":         ["robbery","robbed","theft","stolen","assault","murder","kidnap","gun","fight"],
    "Electrical":    ["electric","shock","electrocuted","transformer","short circuit","live wire"]
  };

  /* words that carry no location meaning */
  var STOP = ("near outside at the on in of to from is are was were there here please help urgent and or my our his her its some very big just now close by side front back gate area around next a an it for with people person man woman child sir nadiad gujarat india district city town village").split(" ");

  /* ---------- tiny text helpers ---------- */
  function norm(t) {
    return String(t == null ? "" : t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function tokens(t) { return norm(t).split(" ").filter(function (w) { return w.length > 1; }); }

  /* "Truck crashed outside DDU" -> "Road accident" */
  function classify(text) {
    var tk = tokens(text), best = null, bestN = 0;
    Object.keys(TYPES).forEach(function (cat) {
      var n = 0;
      TYPES[cat].forEach(function (kw) { if (tk.indexOf(kw) > -1) n++; });
      if (n > bestN) { bestN = n; best = cat; }
    });
    return best || "Other";
  }

  /* meaningful place words: "Accident near DDU." -> ["ddu"] */
  function landmarks(text) {
    var typeWords = {};
    Object.keys(TYPES).forEach(function (c) { TYPES[c].forEach(function (w) { typeWords[w] = 1; }); });
    return tokens(text).filter(function (w) { return STOP.indexOf(w) === -1 && !typeWords[w]; });
  }

  function overlap(a, b) {                     // Jaccard similarity
    if (!a.length || !b.length) return 0;
    var A = {}, i = 0, u = 0;
    a.forEach(function (x) { A[x] = 1; });
    b.forEach(function (x) { if (!A[x]) u++; });
    Object.keys(A).forEach(function (x) { u++; if (b.indexOf(x) > -1) i++; });
    return u ? i / u : 0;
  }

  /* accept any field naming from your report form */
  function adapt(r) {
    return {
      message:  r.message || r.text || r.description || r.report || "",
      location: r.location || r.address || r.landmark || "",
      name:     r.name || r.reporter || "Citizen",
      phone:    r.phone || r.mobile || "—",
      time:     r.time || r.timestamp || Date.now(),
      category: r.category || r.type || null,
      severity: r.severity || null,
      raw:      r
    };
  }

  /* ---------- THE AI: score one report against one incident ---------- */
  function score(rep, inc) {
    /* 1. emergency type match */
    var rCat = rep.category || classify(rep.message);
    var typeSim = (rCat === inc.category) ? 1
                : (rCat === "Other" || inc.category === "Other") ? 0.5 : 0;

    /* 2. location match (shared landmark words) */
    var repLM = landmarks(rep.message + " " + rep.location);
    var incLM = [];
    (inc.reports || []).forEach(function (x) {
      incLM = incLM.concat(landmarks((x.message || "") + " " + (x.location || "")));
    });
    var locSim = overlap(repLM, incLM);
    var shared = repLM.filter(function (w) { return incLM.indexOf(w) > -1; });
    if (shared.length) locSim = Math.min(1, locSim + 0.25);   // shared landmark bonus

    /* 3. time closeness (full marks <=10 min, fades by 60 min) */
    var dt = (Date.now() - (inc.lastReport || inc.created || Date.now())) / 60000;
    var timeSim = dt <= 10 ? 1 : (dt <= 60 ? 1 - (dt - 10) / 50 : 0);

    var total = 0.40 * typeSim + 0.40 * locSim + 0.20 * timeSim;
    var why = [];
    if (typeSim === 1) why.push('same emergency type "' + rCat + '"');
    if (shared.length) why.push("shared place word: " + shared.slice(0, 3).join(", "));
    if (timeSim > 0.5) why.push("reported minutes apart");

    return { score: total, reason: why.join(" + ") || "weak overlap", category: rCat };
  }

  /* ---------- main entry: NEW incident or MERGE? ---------- */
  function decide(rawReport, incidents) {
    var rep = adapt(rawReport);
    var best = null;
    (incidents || []).forEach(function (inc) {
      if (inc.status === "Resolved") return;         // never merge into closed ones
      var s = score(rep, inc);
      if (!best || s.score > best.score) best = { target: inc, score: s.score, reason: s.reason };
    });
    if (best && best.score >= THRESHOLD) {
      return { merge: true, target: best.target, score: best.score,
               reason: "AI merge " + Math.round(best.score * 100) + "% — " + best.reason, rep: rep };
    }
    return { merge: false, score: best ? best.score : 0, rep: rep,
             category: rep.category || classify(rep.message) };
  }

  /* ---------- perform the merge (call when decide().merge is true) ---------- */
  var RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };
  function mergeInto(inc, rawReport, reason) {
    var rep = adapt(rawReport);
    inc.reports = inc.reports || [];
    inc.reports.push({ name: rep.name, phone: rep.phone, message: rep.message,
                       location: rep.location, time: rep.time, why: reason || "AI merged duplicate report" });
    inc.lastReport = Date.now();
    var sev = rep.severity || (/\b(dead|critical|fire|explosion|trapped|unconscious)\b/.test(norm(rep.message)) ? "Critical" : null);
    if (sev && (RANK[sev] || 0) > (RANK[inc.severity] || 2)) inc.severity = sev;  // escalate if worse
    return inc;
  }

  return { decide: decide, mergeInto: mergeInto, classify: classify, adapt: adapt, THRESHOLD: THRESHOLD };
})();
