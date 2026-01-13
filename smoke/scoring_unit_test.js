/* eslint-disable no-console */
"use strict";

const assert = require("assert");
const { computePayEachClassic, computeMazaPayEach, computeGaldinsDeltas } = require("../scoring");

function eq(a, b, msg) {
  assert.deepStrictEqual(a, b, msg);
}

// TAKE
eq(computePayEachClassic("ŅEMT GALDU", 61, 5).payEachSigned, 1, "TAKE win +1");
eq(computePayEachClassic("ŅEMT GALDU", 90, 7).payEachSigned, 1, "TAKE win still +1 when oppEyes>=30");
eq(computePayEachClassic("ŅEMT GALDU", 91, 7).payEachSigned, 2, "TAKE win +2 when oppEyes<30");
eq(computePayEachClassic("ŅEMT GALDU", 120, 8).payEachSigned, 3, "TAKE win +3 when oppTricks==0");
eq(computePayEachClassic("ŅEMT GALDU", 60, 3).payEachSigned, -2, "TAKE lose -2");
eq(computePayEachClassic("ŅEMT GALDU", 30, 1).payEachSigned, -3, "TAKE lose -3 when bigEyes<31");
eq(computePayEachClassic("ŅEMT GALDU", 0, 0).payEachSigned, -4, "TAKE lose -4 when bigTricks==0");

// ZOLE
eq(computePayEachClassic("ZOLE", 61, 5).payEachSigned, 5, "ZOLE win +5");
eq(computePayEachClassic("ZOLE", 91, 6).payEachSigned, 6, "ZOLE win +6 when bigEyes>=91");
eq(computePayEachClassic("ZOLE", 120, 8).payEachSigned, 7, "ZOLE win +7 when all tricks");
eq(computePayEachClassic("ZOLE", 60, 3).payEachSigned, -6, "ZOLE lose -6");
eq(computePayEachClassic("ZOLE", 30, 1).payEachSigned, -7, "ZOLE lose -7 when bigEyes<31");
eq(computePayEachClassic("ZOLE", 0, 0).payEachSigned, -8, "ZOLE lose -8 when bigTricks==0");

// MAZĀ
eq(computeMazaPayEach(0).payEachSigned, 6, "MAZĀ win +6 each");
eq(computeMazaPayEach(1).payEachSigned, -7, "MAZĀ lose -7 each");

// GALDIŅŠ (p=2)
eq(computeGaldinsDeltas([4, 2, 2], [40, 40, 40], 2).deltas, [-6, 2, 2], "GALDS loser by tricks");
eq(computeGaldinsDeltas([3, 3, 2], [50, 40, 30], 2).deltas, [-6, 2, 2], "GALDS tie by tricks, loser by eyes");
eq(computeGaldinsDeltas([3, 3, 2], [40, 40, 30], 2), null, "GALDS full tie -> null");

console.log("[scoring_unit_test] OK");

